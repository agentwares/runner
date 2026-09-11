#!/usr/bin/env node
/**
 * readiness probe — "can an agent sign up to this SaaS?"
 *
 *   node probe/probe.mjs --url https://example.com/signup [--scan-id <id>] [--out evidence.json]
 *                        [--timeout 120000] [--post <callbackUrl>] [--headed]
 *   node probe/probe.mjs post --file evidence.json --scan-id <id> --url <callbackUrl>
 *
 * Runs Playwright (chromium) against a signup URL whose owner verified the domain,
 * records what an agent would find (form, CAPTCHA, terms, submit outcome, API-key
 * path, docs) as `agentwares.readiness-evidence/v1` JSON, and optionally POSTs it
 * signed with READINESS_CALLBACK_SECRET (X-Agentwares-Signature: sha256=<hmac>).
 *
 * Rules: identifies itself in the User-Agent, uses @example.com addresses, never
 * solves or bypasses CAPTCHAs (detects, records, stops), touches ≤ 12 pages.
 * Plain JS with no deps beyond `playwright` so the public runner can copy it verbatim.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";

export const PROBE_VERSION = "probe/0.1.0";
export const EVIDENCE_SCHEMA_ID = "agentwares.readiness-evidence/v1";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AgentwaresReadinessProbe/0.1 (+https://agentwares-readiness.vercel.app/rubric)";
const MAX_PAGES = 12;
const TEXT_CAP = 8000;

/** @typedef {import("playwright").Page} Page */
/** @typedef {import("playwright").Frame} Frame */

const RX = {
  signup:
    /sign ?up|register|create (an )?account|get started|start (for )?free|try (it )?free|join/i,
  login: /log ?in|sign ?in/i,
  docs: /\bdocs?\b|documentation|developers?|api reference|\bapi\b/i,
  terms: /terms|tos\b|legal|conditions/i,
  apiKeys:
    /api[ -]?keys?|access tokens?|personal access token|credentials|secret key|developer settings/i,
  createKey: /create|generate|new (api )?key|add key|issue/i,
  oauth: /github|google|microsoft|apple|gitlab|slack|discord|okta|auth0|sso|oauth/i,
  /** Vendor names only. The bare word "captcha" appears in prose ("no CAPTCHA"). */
  captcha: /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkose|funcaptcha|geetest/i,
  /** A challenge actually being demanded, rather than the word being mentioned. */
  captchaDemand:
    /(complete|solve|verify|pass)\b[^.]{0,24}\bcaptcha|captcha\b[^.]{0,24}(required|failed|verification)/i,
  emailVerify:
    /verify your email|check your (inbox|email|mail)|confirmation (email|link)|we('ve| have) sent (you )?an? (email|link)|confirm your email|verification (email|link|code)/i,
  success: /dashboard|welcome|api key|get started|onboarding|workspace|your account|overview/i,
  /**
   * A credential rendered on the page: `sk_live_…`, `ak_live_…`, `ghp_…`, a bare
   * 32+ char token. This is the thing the rubric is actually asking about — an
   * agent that can read a key off the response has completed signup without a
   * human — so it beats matching words like "dashboard".
   */
  credential: /\b[a-z][a-z0-9]{1,12}_(?:live_|test_|pat_)?[A-Za-z0-9]{24,}\b|\b[A-Fa-f0-9]{40,}\b/,
  blocked:
    /not a robot|access denied|forbidden|unusual (activity|traffic)|rate limit|too many requests/i,
  errorText:
    /invalid|required|must|already (exists|taken|registered)|error|try again|weak|too short/i,
  /** machine endpoints that match `docs` on the path but are not documentation */
  notDocs:
    /\/(health|healthz|status|ping|metrics|webhook|webhooks|callback|tick|cron|mcp|auth|oauth|signin|signout|session)(\/|$)|\.(json|xml|ya?ml|svg|png|txt)$/i,
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

/** @param {string} s */
function clip(s, n = TEXT_CAP) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) : t;
}

/** @param {string} u */
function safeHost(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Evidence skeleton. @param {string} url */
export function emptyEvidence(url) {
  const origin = new URL(url).origin;
  return {
    schema: EVIDENCE_SCHEMA_ID,
    probeVersion: PROBE_VERSION,
    url,
    origin,
    finalUrl: null,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    pages: /** @type {{role:string,url:string,status:number|null,title:string|null}[]} */ ([]),
    signup: {
      formFound: false,
      formUrl: null,
      fields: /** @type {string[]} */ ([]),
      hasEmail: false,
      hasPassword: false,
      oauthProviders: /** @type {string[]} */ ([]),
      captcha: { detected: false, vendor: /** @type {string|null} */ (null) },
      tos: { checkbox: false, inlineText: false, linkUrl: /** @type {string|null} */ (null) },
      submit: {
        credentialShown: false,
        attempted: false,
        outcome: /** @type {"success"|"email_verification"|"blocked"|"error"|"not_attempted"} */ (
          "not_attempted"
        ),
        detail: /** @type {string|null} */ (null),
        finalUrl: /** @type {string|null} */ (null),
      },
    },
    apiKeys: {
      mentioned: false,
      pageUrl: /** @type {string|null} */ (null),
      createControl: false,
      detail: /** @type {string|null} */ (null),
    },
    docs: {
      llmsTxt: { status: /** @type {number|null} */ (null), bytes: 0 },
      openapi: {
        status: /** @type {number|null} */ (null),
        url: /** @type {string|null} */ (null),
      },
      pricingJson: { status: /** @type {number|null} */ (null) },
      mcp: { mentioned: false, url: /** @type {string|null} */ (null) },
      docsUrl: /** @type {string|null} */ (null),
      docsText: /** @type {string|null} */ (null),
      termsUrl: /** @type {string|null} */ (null),
      termsText: /** @type {string|null} */ (null),
    },
    errors: /** @type {string[]} */ ([]),
  };
}

/** Same-site link discovery. @param {Page} page */
async function collectLinks(page) {
  /** @type {{href:string,text:string}[]} */
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]")).map((a) => ({
      href: /** @type {HTMLAnchorElement} */ (a).href,
      text: ((a.textContent || "") + " " + (a.getAttribute("aria-label") || ""))
        .trim()
        .slice(0, 120),
    })),
  );
  const host = safeHost(page.url());
  return links.filter(
    (l) =>
      l.href.startsWith("http") &&
      safeHost(l.href) === host &&
      !/^(mailto|tel|javascript):/.test(l.href),
  );
}

/**
 * First link whose visible text or pathname matches `rx`. Text matches win over
 * path matches (a nav item labelled "Docs" beats any URL that merely contains
 * "api"), and `avoid` drops machine endpoints that would otherwise look like docs.
 * @param {{href:string,text:string}[]} links @param {RegExp} rx @param {RegExp} [avoid]
 */
function pickLink(links, rx, avoid) {
  const usable = links.filter((l) => !avoid || !avoid.test(new URL(l.href).pathname));
  return (
    usable.find((l) => rx.test(l.text))?.href ??
    usable.find((l) => rx.test(new URL(l.href).pathname))?.href ??
    null
  );
}

/** Inspect the current page for a signup form. @param {Page} page */
async function inspectForm(page) {
  return page.evaluate(() => {
    const forms = Array.from(document.querySelectorAll("form"));
    const inputsOf = (root) =>
      Array.from(root.querySelectorAll("input,select,textarea")).filter((el) => {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        return !["hidden", "submit", "button", "image", "reset"].includes(t);
      });
    const isEmail = (el) =>
      (el.getAttribute("type") || "").toLowerCase() === "email" ||
      /e-?mail/i.test(
        `${el.getAttribute("name")} ${el.id} ${el.getAttribute("placeholder")} ${el.getAttribute("autocomplete")}`,
      );
    const isPassword = (el) => (el.getAttribute("type") || "").toLowerCase() === "password";
    const candidates = forms.length ? forms : [document.body];
    let best = null;
    for (const f of candidates) {
      const inputs = inputsOf(f);
      const hasEmail = inputs.some(isEmail);
      const hasPassword = inputs.some(isPassword);
      const score = (hasEmail ? 2 : 0) + (hasPassword ? 2 : 0) + Math.min(inputs.length, 5) * 0.1;
      if (!best || score > best.score) {
        const textOf = f.textContent || "";
        best = {
          score,
          isForm: f.tagName === "FORM",
          hasEmail,
          hasPassword,
          fields: inputs
            .map(
              (el) =>
                `${(el.getAttribute("type") || el.tagName).toLowerCase()}:${el.getAttribute("name") || el.id || ""}`,
            )
            .slice(0, 30),
          tosCheckbox: inputs.some(
            (el) =>
              (el.getAttribute("type") || "").toLowerCase() === "checkbox" &&
              /terms|agree|privacy|policy|consent/i.test(
                `${el.getAttribute("name")} ${el.id} ${el.closest("label")?.textContent || ""} ${el.getAttribute("aria-label") || ""} ${document.querySelector(`label[for="${el.id}"]`)?.textContent || ""}`,
              ),
          ),
          tosInline:
            /by (signing|clicking|creating|continuing|registering)[^.]{0,80}(agree|accept)|agree to (the|our) terms/i.test(
              textOf,
            ),
          tosLink:
            Array.from(f.querySelectorAll("a[href]"))
              .map((a) => /** @type {HTMLAnchorElement} */ (a).href)
              .find((h) => /terms|tos|legal/i.test(h)) || null,
          buttons: Array.from(f.querySelectorAll("button,a[role=button],input[type=submit]")).map(
            (b) =>
              (b.textContent || /** @type {HTMLInputElement} */ (b).value || "")
                .trim()
                .slice(0, 60),
          ),
        };
      }
    }
    const oauth = Array.from(document.querySelectorAll("a[href],button"))
      .map(
        (el) =>
          `${el.textContent || ""} ${el.getAttribute("href") || ""} ${el.getAttribute("aria-label") || ""}`,
      )
      .filter((s) => /github|google|microsoft|apple|gitlab|slack|discord|okta|sso|oauth/i.test(s))
      .map((s) =>
        (s.match(/github|google|microsoft|apple|gitlab|slack|discord|okta|sso|oauth/i) || [
          "",
        ])[0].toLowerCase(),
      );
    const html = document.documentElement.outerHTML.slice(0, 400000);
    const cap = html.match(
      /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkose|funcaptcha|geetest/i,
    );
    const captchaWidget = Boolean(
      document.querySelector(
        'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="turnstile"],iframe[src*="challenges.cloudflare"],.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey]',
      ),
    );
    return {
      form: best,
      oauth: Array.from(new Set(oauth)),
      captcha: {
        detected: Boolean(cap) || captchaWidget,
        vendor: cap ? cap[0] : captchaWidget ? "captcha widget" : null,
      },
      apiKeysMentioned: /api[ -]?keys?|access tokens?|personal access token/i.test(
        document.body?.innerText || "",
      ),
      text: (document.body?.innerText || "").slice(0, 20000),
    };
  });
}

/**
 * A CAPTCHA that is actually present: a vendor script or a widget container.
 * Deliberately not a text match — plenty of honest signup pages say "no CAPTCHA".
 * @param {Page} page
 */
async function hasCaptchaWidget(page) {
  return page
    .evaluate(() => {
      const html = document.documentElement.outerHTML;
      const vendor =
        /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkose|funcaptcha|geetest/i;
      const scripts = Array.from(document.querySelectorAll("script[src],iframe[src]")).some((el) =>
        vendor.test(el.getAttribute("src") || ""),
      );
      const widget = Boolean(
        document.querySelector(
          'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="turnstile"],iframe[src*="challenges.cloudflare"],.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey]',
        ),
      );
      return scripts || widget || /grecaptcha|hcaptcha\.render|turnstile\.render/.test(html);
    })
    .catch(() => false);
}

/** Try to submit the signup form. @param {Page} page @param {ReturnType<typeof emptyEvidence>} ev */
async function attemptSignup(page, ev) {
  const id = randomBytes(4).toString("hex");
  const email = `agentwares-probe-${id}@example.com`;
  const password = `Probe-${id}-Aa1!x`;
  const before = page.url();
  try {
    const scope = (await page.locator("form").count())
      ? page.locator("form").first()
      : page.locator("body");
    const emailInput = scope
      .locator(
        'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]',
      )
      .first();
    if (await emailInput.count()) await emailInput.fill(email);
    const pwInputs = scope.locator('input[type="password"]');
    const n = await pwInputs.count();
    for (let i = 0; i < n; i += 1) await pwInputs.nth(i).fill(password);
    const nameInputs = scope.locator(
      'input[name*="name" i]:not([type="email"]):not([type="password"]), input[id*="name" i]:not([type="email"]):not([type="password"]), input[autocomplete="name"], input[autocomplete="given-name"], input[autocomplete="family-name"], input[autocomplete="organization"]',
    );
    const nn = await nameInputs.count();
    for (let i = 0; i < Math.min(nn, 4); i += 1) {
      const cur = await nameInputs
        .nth(i)
        .inputValue()
        .catch(() => "");
      if (!cur)
        await nameInputs
          .nth(i)
          .fill("Agentwares Probe")
          .catch(() => undefined);
    }
    const boxes = scope.locator('input[type="checkbox"]');
    const bn = await boxes.count();
    for (let i = 0; i < Math.min(bn, 6); i += 1) {
      const box = boxes.nth(i);
      if (!(await box.isChecked().catch(() => true)))
        await box.check({ force: true }).catch(() => undefined);
    }
    ev.signup.submit.attempted = true;
    const submit = scope
      .locator(
        'button[type="submit"], input[type="submit"], button:has-text("Sign up"), button:has-text("Create account"), button:has-text("Register"), button:has-text("Continue"), button:has-text("Get started")',
      )
      .first();
    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined),
      (await submit.count()) ? submit.click({ timeout: 5000 }) : page.keyboard.press("Enter"),
    ]);
    await page.waitForTimeout(1500);
    const after = page.url();
    const text = clip(await page.evaluate(() => document.body?.innerText || ""), 20000);
    const codeText = clip(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll("pre,code,input[readonly]"))
          .map((el) => (el instanceof HTMLInputElement ? el.value : el.textContent) || "")
          .join("\n"),
      ),
      8000,
    );
    ev.signup.submit.credentialShown = RX.credential.test(codeText);
    ev.signup.submit.finalUrl = after;
    if (ev.signup.submit.credentialShown) {
      ev.signup.submit.outcome = "success";
      ev.signup.submit.detail = "a credential was returned on the page after submitting";
    } else if (RX.emailVerify.test(text)) {
      ev.signup.submit.outcome = "email_verification";
      ev.signup.submit.detail = clip(
        text.match(RX.emailVerify)?.[0] ?? "email verification requested",
        200,
      );
    } else if (
      RX.blocked.test(text) ||
      RX.captchaDemand.test(text) ||
      (await hasCaptchaWidget(page))
    ) {
      ev.signup.submit.outcome = "blocked";
      ev.signup.submit.detail = clip(
        text.match(RX.blocked)?.[0] ?? text.match(RX.captchaDemand)?.[0] ?? "bot protection",
        200,
      );
    } else if (after !== before && !RX.signup.test(new URL(after).pathname)) {
      ev.signup.submit.outcome = "success";
      ev.signup.submit.detail = `navigated to ${new URL(after).pathname}`;
    } else if (RX.success.test(text) && !RX.errorText.test(text.slice(0, 3000))) {
      // Words like "api key" or "get started" often sit on the signup page itself,
      // so matching them while still on that page proves nothing. Only call it a
      // success if the form is gone; otherwise say we could not tell, which scores
      // as unobserved rather than inventing a pass.
      const formStillPresent = await page
        .locator("form input:not([type=hidden])")
        .count()
        .then((n) => n > 0)
        .catch(() => false);
      if (formStillPresent) {
        ev.signup.submit.outcome = "error";
        ev.signup.submit.detail =
          "submitted, but the form is still on screen and no credential or redirect appeared — could not confirm an account was created";
        return text;
      }
      ev.signup.submit.outcome = "success";
      ev.signup.submit.detail = "success text on the page";
    } else {
      ev.signup.submit.outcome = "error";
      const err = await page
        .locator('[role="alert"], .error, [class*="error" i], [aria-invalid="true"] ~ *, small, p')
        .filter({ hasText: RX.errorText })
        .first()
        .textContent({ timeout: 1000 })
        .catch(() => null);
      ev.signup.submit.detail = clip(err ?? "no navigation or success text after submit", 200);
    }
    ev.signup.submit.finalUrl = after;
    return text;
  } catch (err) {
    ev.signup.submit.outcome = "error";
    ev.signup.submit.detail = clip(String(err instanceof Error ? err.message : err), 200);
    return "";
  }
}

/** Fetch a same-origin JSON/text endpoint through the browser context. @param {import("playwright").BrowserContext} ctx */
async function head(ctx, url) {
  try {
    const res = await ctx.request.get(url, {
      timeout: 10000,
      maxRedirects: 3,
      failOnStatusCode: false,
    });
    const body = res.ok() ? await res.text() : "";
    return { status: res.status(), body, url: res.url() };
  } catch {
    return { status: null, body: "", url };
  }
}

/** Visit a page, record it, return innerText. @param {Page} page @param {ReturnType<typeof emptyEvidence>} ev */
async function visit(page, ev, url, role) {
  if (ev.pages.length >= MAX_PAGES) return null;
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
    ev.pages.push({
      role,
      url: page.url(),
      status: res?.status() ?? null,
      title: clip((await page.title().catch(() => "")) || "", 300) || null,
    });
    return clip(await page.evaluate(() => document.body?.innerText || ""), 20000);
  } catch (err) {
    ev.errors.push(
      `${role} ${url}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    );
    ev.pages.push({ role, url, status: null, title: null });
    return null;
  }
}

/**
 * Run the probe. @param {string} url @param {{timeoutMs?: number, headed?: boolean, launch?: (opts: object) => Promise<import("playwright").Browser>}} [opts]
 */
export async function probe(url, opts = {}) {
  const ev = emptyEvidence(url);
  const t0 = Date.now();
  const budget = opts.timeoutMs ?? 120000;
  const { chromium } = await import("playwright");
  const browser = await (opts.launch ?? ((o) => chromium.launch(o)))({ headless: !opts.headed });
  const timer = setTimeout(() => {
    ev.errors.push(`probe budget ${budget}ms exceeded`);
    browser.close().catch(() => undefined);
  }, budget);
  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });
    context.setDefaultTimeout(15000);
    const page = await context.newPage();

    // 1. entry page
    let text = await visit(page, ev, url, "entry");
    ev.finalUrl = page.url();
    let links = text !== null ? await collectLinks(page) : [];
    let insp = text !== null ? await inspectForm(page) : null;

    // 2. move to a signup page when the entry has no fillable form
    let formPage = page.url();
    if (!insp?.form?.hasEmail) {
      const signupHref =
        pickLink(links, RX.signup) ??
        (text !== null && RX.login.test(text) ? pickLink(links, RX.login) : null);
      if (signupHref && signupHref !== page.url()) {
        const t2 = await visit(page, ev, signupHref, "signup");
        if (t2 !== null) {
          text = t2;
          links = [...links, ...(await collectLinks(page))];
          insp = await inspectForm(page);
          formPage = page.url();
        }
      }
    }
    if (insp) {
      const f = insp.form;
      ev.signup.oauthProviders = insp.oauth;
      ev.signup.captcha = insp.captcha;
      ev.apiKeys.mentioned = insp.apiKeysMentioned;
      if (f && (f.hasEmail || f.hasPassword)) {
        ev.signup.formFound = true;
        ev.signup.formUrl = formPage;
        ev.signup.fields = f.fields;
        ev.signup.hasEmail = f.hasEmail;
        ev.signup.hasPassword = f.hasPassword;
        ev.signup.tos = { checkbox: f.tosCheckbox, inlineText: f.tosInline, linkUrl: f.tosLink };
      }
    }
    ev.docs.termsUrl = ev.signup.tos.linkUrl ?? pickLink(links, RX.terms);
    ev.docs.docsUrl = pickLink(links, RX.docs, RX.notDocs);

    // 3. submit (only with a fillable form and no CAPTCHA)
    let postText = "";
    // Attempt any form that is not behind a CAPTCHA, and let the OUTCOME decide.
    // This used to require both an email and a password field, which scored 0 for
    // every passwordless or optional-email signup without ever trying one — a
    // false negative, and precisely the shape an agent-first signup takes. If a
    // flow really does need a mailbox, the outcome is `email_verification` and it
    // is scored as such; if it returns credentials inline, that is a real success.
    if (ev.signup.formFound && !ev.signup.captcha.detected) {
      postText = await attemptSignup(page, ev);
    } else if (ev.signup.formFound && ev.signup.captcha.detected) {
      ev.signup.submit.detail = `not attempted: ${ev.signup.captcha.vendor ?? "CAPTCHA"} present (never solved)`;
    } else {
      ev.signup.submit.detail = ev.signup.oauthProviders.length
        ? "not attempted: OAuth-only signup"
        : "not attempted: no signup form found";
    }

    // 4. API keys: post-signup page → links on it → docs page
    if (ev.signup.submit.outcome === "success") {
      const postLinks = await collectLinks(page).catch(() => []);
      const keysHref = pickLink(postLinks, RX.apiKeys);
      if (RX.apiKeys.test(postText)) ev.apiKeys.mentioned = true;
      if (keysHref) {
        const kt = await visit(page, ev, keysHref, "api-keys");
        if (kt !== null) {
          ev.apiKeys.pageUrl = page.url();
          ev.apiKeys.mentioned = true;
          const btn = await page
            .locator("button, a[role=button], input[type=submit]")
            .filter({ hasText: RX.createKey })
            .count();
          ev.apiKeys.createControl = btn > 0;
          ev.apiKeys.detail =
            btn > 0
              ? "create/generate control on the keys page"
              : "keys page without a create control";
        }
      }
    }

    // 5. docs + terms text
    const docsHref = ev.docs.docsUrl;
    if (docsHref) {
      const dt = await visit(page, ev, docsHref, "docs");
      if (dt !== null) {
        ev.docs.docsUrl = page.url();
        ev.docs.docsText = clip(dt);
        if (RX.apiKeys.test(dt)) {
          ev.apiKeys.mentioned = true;
          ev.apiKeys.detail ??= "mentioned in the docs";
          if (!ev.apiKeys.pageUrl) {
            const kl = pickLink(await collectLinks(page).catch(() => []), RX.apiKeys);
            if (kl) ev.apiKeys.detail = `docs link to ${kl}`;
          }
        }
        if (/\bmcp\b/i.test(dt))
          ev.docs.mcp = {
            mentioned: true,
            url: pickLink(await collectLinks(page).catch(() => []), /mcp/i),
          };
      }
    }
    if (ev.docs.termsUrl) {
      const tt = await visit(page, ev, ev.docs.termsUrl, "terms");
      if (tt !== null) {
        ev.docs.termsUrl = page.url();
        ev.docs.termsText = clip(tt);
      }
    }

    // 6. machine-readable endpoints
    const llms = await head(context, `${ev.origin}/llms.txt`);
    ev.docs.llmsTxt = { status: llms.status, bytes: llms.body.length };
    if (llms.body) {
      if (!ev.docs.docsText && /docs|api/i.test(llms.body)) ev.docs.docsText = clip(llms.body);
      const mcp = llms.body.match(/https?:\/\/\S*mcp\S*/i);
      if (mcp) ev.docs.mcp = { mentioned: true, url: mcp[0].replace(/[),.]+$/, "") };
      if (RX.apiKeys.test(llms.body)) ev.apiKeys.mentioned = true;
    }
    for (const candidate of [
      "/openapi.json",
      "/.well-known/openapi.json",
      "/api/openapi.json",
      "/openapi.yaml",
    ]) {
      const r = await head(context, `${ev.origin}${candidate}`);
      if (r.status === 200 && /openapi|swagger/i.test(r.body.slice(0, 2000))) {
        ev.docs.openapi = { status: 200, url: `${ev.origin}${candidate}` };
        break;
      }
      if (ev.docs.openapi.status === null) ev.docs.openapi = { status: r.status, url: null };
    }
    ev.docs.pricingJson = { status: (await head(context, `${ev.origin}/pricing.json`)).status };

    await context.close();
  } catch (err) {
    ev.errors.push(`probe: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => undefined);
  }
  ev.durationMs = Date.now() - t0;
  return ev;
}

/** Sign + POST evidence to the scorer callback. */
export async function postEvidence(callbackUrl, scanId, evidence, secret, runner = {}) {
  const payload = JSON.stringify({
    scanId,
    evidence,
    runner: { workflowRunId: process.env.GITHUB_RUN_ID ?? null, os: process.platform, ...runner },
  });
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  const res = await fetch(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentwares-signature": `sha256=${sig}` },
    body: payload,
  });
  const body = await res.text();
  return { status: res.status, body };
}

async function main() {
  const [sub] = process.argv.slice(2);
  if (sub === "post") {
    const file = arg("file", "evidence.json");
    const url = arg("url");
    const scanId = arg("scan-id");
    const secret = process.env.READINESS_CALLBACK_SECRET ?? "";
    if (!url || !scanId) {
      console.error(
        "usage: probe.mjs post --file evidence.json --scan-id <id> --url <callbackUrl>",
      );
      return 2;
    }
    if (!secret) {
      console.error("READINESS_CALLBACK_SECRET is not set");
      return 2;
    }
    const evidence = JSON.parse(readFileSync(file, "utf8"));
    const r = await postEvidence(url, scanId, evidence, secret);
    console.log(`callback ${r.status}: ${r.body.slice(0, 300)}`);
    return r.status < 300 ? 0 : 1;
  }
  const url = arg("url") ?? process.argv.slice(2).find((a) => /^https?:\/\//.test(a));
  if (!url) {
    console.error(
      "usage: probe.mjs --url <signupUrl> [--scan-id id] [--out evidence.json] [--timeout ms] [--post callbackUrl] [--headed]",
    );
    return 2;
  }
  const out = arg("out", "evidence.json");
  const timeoutMs = Number(arg("timeout", "120000"));
  const evidence = await probe(url, { timeoutMs, headed: flag("headed") });
  writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(
    `evidence → ${out} (${evidence.pages.length} pages, ${evidence.durationMs}ms, form=${evidence.signup.formFound}, submit=${evidence.signup.submit.outcome}, errors=${evidence.errors.length})`,
  );
  const post = arg("post");
  if (post) {
    const scanId = arg("scan-id");
    const secret = process.env.READINESS_CALLBACK_SECRET ?? "";
    if (!scanId || !secret) {
      console.error("--post needs --scan-id and READINESS_CALLBACK_SECRET");
      return 2;
    }
    const r = await postEvidence(post, scanId, evidence, secret);
    console.log(`callback ${r.status}: ${r.body.slice(0, 300)}`);
    return r.status < 300 ? 0 : 1;
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] && /probe\.mjs$/.test(process.argv[1]) && !process.env.READINESS_PROBE_LIBRARY;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
