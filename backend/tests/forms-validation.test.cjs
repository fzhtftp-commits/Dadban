const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeDigits,
  isValidIranianNationalCode,
  jalaliToGregorian,
  gregorianToJalali,
  isValidJalaliDate,
  localDateTimeToIso
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
