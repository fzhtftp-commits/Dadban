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
