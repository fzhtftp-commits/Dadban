const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const {
  normalizeDigits,
  isValidIranianNationalCode,
  jalaliToGregorian,
  gregorianToJalali,
  isValidJalaliDate,
  localDateTimeToIso,
  isoToLocalDateTime
} = require("../../form-validation.js");

test("normalizes Persian and Arabic-Indic digits", () => {
  assert.equal(normalizeDigits("۱۲۳۴۵۶۷۸۹۰"), "1234567890");
  assert.equal(normalizeDigits("١٢٣٤٥٦٧٨٩٠"), "1234567890");
});

test("validates Iranian national-code checksum and rejects repeated digits", () => {
  assert.equal(isValidIranianNationalCode("1234567891"), true);
  assert.equal(isValidIranianNationalCode("۱۲۳۴۵۶۷۸۹۱"), true);
  assert.equal(isValidIranianNationalCode("1234567890"), false);
  assert.equal(isValidIranianNationalCode("1111111111"), false);
  assert.equal(isValidIranianNationalCode("123456789"), false);
});

test("converts Jalali dates across Nowruz correctly", () => {
  assert.equal(jalaliToGregorian("1402/12/29"), "2024-03-19");
  assert.equal(jalaliToGregorian("1403/01/01"), "2024-03-20");
  assert.equal(gregorianToJalali("2024-03-20"), "1403/01/01");
});

test("rejects impossible Jalali dates including invalid Esfand 30", () => {
  assert.equal(isValidJalaliDate("1402/12/30"), false);
  assert.equal(isValidJalaliDate("1403/12/30"), true);
  assert.equal(isValidJalaliDate("1403/13/01"), false);
  assert.equal(isValidJalaliDate("۱۴۰۳/۰۱/۰۱"), true);
});

test("converts local datetime-local values using local timezone and returns UTC ISO", () => {
  const iso = localDateTimeToIso("2026-10-15T09:30");
  const expected = new Date(2026, 9, 15, 9, 30, 0, 0).toISOString();
  assert.equal(iso, expected);
  assert.equal(localDateTimeToIso(""), null);
  assert.throws(() => localDateTimeToIso("2026-02-30T09:30"), RangeError);
  assert.throws(() => localDateTimeToIso("2026-10-15"), RangeError);
});

test("round-trips ISO timestamps to the browser's local datetime-local representation", () => {
  const localValue = "2026-10-15T09:30";
  assert.equal(isoToLocalDateTime(localDateTimeToIso(localValue)), localValue);
  assert.equal(isoToLocalDateTime("not-a-date"), "");
});

test("client form exposes create/edit fields and loads shared validation before its controller", () => {
  const html = read("client-form.html");
  const js = read("client-form.js");
  assert.match(html, /id="clientForm"/);
  assert.match(html, /id="fullName"/);
  assert.match(html, /id="nationalId"/);
  assert.match(html, /id="mobile"/);
  assert.match(html, /src="form-validation\.js[^"]*"/);
  assert.ok(html.indexOf("form-validation.js") < html.indexOf("client-form.js"));
  assert.match(js, /params\.get\("mode"\) === "edit"/);
  assert.match(js, /method: editMode \? "PATCH" : "POST"/);
  assert.match(js, /x-csrf-token/);
  assert.match(js, /isValidIranianNationalCode\(nationalIdValue\)/);
  assert.match(js, /isValidJalaliDate\(birthDate\.value\)/);
});

test("case form supports create/edit API paths, client lookup, CSRF and tested local-time conversion", () => {
  const html = read("case-form.html");
  const js = read("case-form.js");
  assert.match(html, /id="caseForm"/);
  assert.match(html, /id="client_national_id"/);
  assert.match(html, /id="case_number"/);
  assert.match(html, /id="next_hearing_at"/);
  assert.ok(html.indexOf("form-validation.js") < html.indexOf("case-form.js"));
  assert.match(js, /\/api\/clients\/lookup\?national_id=/);
  assert.match(js, /isValidIranianNationalCode\(value\)/);
  assert.match(js, /method:caseId\?"PATCH":"POST"/);
  assert.match(js, /x-csrf-token/);
  assert.match(js, /next_hearing_at:localDateTimeToIso\(dt\)/);
  assert.match(js, /isoToLocalDateTime\(c\.next_hearing_at\)/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowser } = require("./form-browser-harness.cjs");

async function submitClient({ mode = "", id = "", responses = [], csrf = "test-csrf", initial = {} } = {}) {
  const search = new URLSearchParams();
  if (mode) search.set("mode", mode);
  if (id) search.set("id", id);
  const browser = createBrowser({ script: "client-form.js", search: "?" + search.toString(), responses, csrf, initial });
  await browser.listeners.get("document:DOMContentLoaded")();
  browser.get("fullName").value = initial.fullName || "علی رضایی";
  browser.get("nationalId").value = initial.nationalId || "1234567891";
  browser.get("mobile").value = initial.mobile || "09123456789";
  browser.get("birthDate").value = initial.birthDate || "";
  const handler = browser.listeners.get("clientForm:submit");
  await handler({ preventDefault(){} });
  return browser;
}

async function submitCase({ id = "", responses = [], csrf = "test-csrf", initial = {} } = {}) {
  const browser = createBrowser({ script: "case-form.js", search: id ? "?id=" + id : "", responses, csrf, initial });
  await new Promise(resolve => setImmediate(resolve));
  browser.get("client_national_id").value = initial.client_national_id || "1234567891";
  browser.get("client_id").value = initial.client_id || "client-uuid-mock";
  browser.get("case_number").value = initial.case_number || "CASE-TEST-01";
  browser.get("title").value = initial.title || "پرونده آزمایشی";
  browser.get("next_hearing_at").value = initial.next_hearing_at || "2026-10-15T09:30";
  await browser.listeners.get("client_national_id:input")();
  await browser.listeners.get("caseForm:submit")({ preventDefault(){} });
  return browser;
}

test("client create sends POST with valid checksum, CSRF and normalized payload", async () => {
  const b = await submitClient({ responses: [{status:201, body:{data:{id:"new-client"}}}] });
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].options.method, "POST");
  assert.match(b.calls[0].url, /\/api\/clients$/);
  assert.equal(b.calls[0].options.headers["x-csrf-token"], "test-csrf");
  const payload = JSON.parse(b.calls[0].options.body);
  assert.equal(payload.national_id, "1234567891");
  assert.equal(payload.full_name, "علی رضایی");
  assert.match(b.get("formMessage").textContent, /با موفقیت/);
});

test("client create rejects invalid checksum before calling API", async () => {
  const b = await submitClient({ initial: {nationalId:"1234567890"} });
  assert.equal(b.calls.length, 0);
  assert.match(b.get("formMessage").textContent, /کد ملی معتبر/);
});

test("client edit loads existing record then sends PATCH; server validation errors are shown", async () => {
  const b = await submitClient({ mode:"edit", id:"client-1", responses:[
    {status:200,body:{data:{id:"client-1",client_type:"individual",full_name:"علی رضایی",national_id:"1234567891",birth_date:"1990-03-21",mobile:"09123456789"}}},
    {status:400,body:{error:"invalid_client"}}
  ]});
  assert.equal(b.calls.length, 2);
  assert.match(b.calls[0].url, /\/api\/clients\/client-1$/);
  assert.equal(b.calls[1].options.method, "PATCH");
  assert.match(b.get("formMessage").textContent, /معتبر نیست/);
});

test("client create refuses to send when CSRF token is missing", async () => {
  const b = await submitClient({csrf:""});
  assert.equal(b.calls.length, 0);
  assert.match(b.get("formMessage").textContent, /نشست امنیتی/);
});

test("case create looks up the client and POSTs case data with CSRF and UTC ISO date", async () => {
  const b = await submitCase({responses:[
    {status:200,body:{data:{id:"client-uuid-mock",full_name:"علی رضایی"}}},
    {status:201,body:{data:{id:"case-new"}}}
  ]});
  assert.equal(b.calls.length, 2);
  assert.match(b.calls[0].url, /\/api\/clients\/lookup\?national_id=1234567891$/);
  assert.equal(b.get("client_id").value, "client-uuid-mock");
  assert.equal(b.calls[1].options.method, "POST");
  assert.equal(b.calls[1].options.headers["x-csrf-token"], "test-csrf");
  assert.equal(JSON.parse(b.calls[1].options.body).next_hearing_at, new Date(2026,9,15,9,30).toISOString());
});

test("case client lookup rejects invalid checksum without contacting API", async () => {
  const b = createBrowser({script:"case-form.js"});
  b.get("client_national_id").value = "1234567890";
  await b.listeners.get("client_national_id:input")();
  assert.equal(b.calls.length, 0);
  assert.match(b.get("clientLookupMessage").textContent, /کد ملی معتبر/);
});

test("case create surfaces server CSRF rejection without pretending success", async () => {
  const b = await submitCase({responses:[
    {status:200,body:{data:{id:"client-uuid-mock",full_name:"علی رضایی"}}},
    {status:403,body:{error:"csrf_token_invalid"}}
  ]});
  assert.equal(b.calls[1].options.method, "POST");
  assert.match(b.get("formMessage").textContent, /ذخیره پرونده انجام نشد/);
  assert.doesNotMatch(b.get("formMessage").textContent, /موفقیت/);
});

test("case edit loads a mock existing case and sends PATCH", async () => {
  const b = createBrowser({script:"case-form.js",search:"?id=case-1",responses:[
    {status:200,body:{data:{id:"case-1",client_id:"client-uuid-mock",client_full_name:"علی رضایی",national_id:"1234567891",case_number:"CASE-OLD",title:"عنوان قبلی",status:"active",priority:"normal",next_hearing_at:"2026-10-15T06:00:00.000Z"}}},
    {status:200,body:{data:{id:"case-1"}}}
  ]});
  await new Promise(resolve => setImmediate(resolve));
  await b.listeners.get("caseForm:submit")({preventDefault(){}});
  assert.equal(b.calls.length, 2);
  assert.match(b.calls[0].url, /\/api\/cases\/case-1$/);
  assert.equal(b.calls[1].options.method, "PATCH");
  assert.equal(JSON.parse(b.calls[1].options.body).case_number, "CASE-OLD");
});
