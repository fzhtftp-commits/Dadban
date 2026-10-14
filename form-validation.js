/* Shared pure helpers for browser forms and Node's built-in test runner. */
(function (root) {
  "use strict";

  const normalizeDigits = (value) => String(value || "")
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 1632));

  function isValidIranianNationalCode(value) {
    const code = normalizeDigits(value).replace(/\s/g, "");
    if (!/^\d{10}$/.test(code) || /^([0-9])\1{9}$/.test(code)) return false;
    const sum = code.slice(0, 9).split("").reduce((total, digit, index) => total + Number(digit) * (10 - index), 0);
    const remainder = sum % 11;
    const checkDigit = Number(code[9]);
    return checkDigit === (remainder < 2 ? remainder : 11 - remainder);
  }

  function jalaliToGregorian(input) {
    const value = normalizeDigits(input).replace(/-/g, "/").trim();
    const match = value.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!match) return null;
    const jy = Number(match[1]), jm = Number(match[2]), jd = Number(match[3]);
    if (jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;

    let year = jy - 979;
    let dayNo = 365 * year + Math.floor(year / 33) * 8 + Math.floor(((year % 33) + 3) / 4);
    for (let month = 1; month < jm; month++) dayNo += month <= 6 ? 31 : 30;
    dayNo += jd - 1;
    let gDayNo = dayNo + 79;
    let gy = 1600 + 400 * Math.floor(gDayNo / 146097);
    gDayNo %= 146097;
    let leap = true;
    if (gDayNo >= 36525) {
      gDayNo--;
      gy += 100 * Math.floor(gDayNo / 36524);
      gDayNo %= 36524;
      if (gDayNo >= 365) gDayNo++;
      else leap = false;
    }
    gy += 4 * Math.floor(gDayNo / 1461);
    gDayNo %= 1461;
    if (gDayNo >= 366) {
      leap = false;
      gDayNo--;
      gy += Math.floor(gDayNo / 365);
      gDayNo %= 365;
    }
    let gd = gDayNo + 1;
    const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let gm = 0;
    while (gm < 11 && gd > monthDays[gm]) { gd -= monthDays[gm]; gm++; }
    const result = `${gy}-${String(gm + 1).padStart(2, "0")}-${String(gd).padStart(2, "0")}`;
    return result;
  }

  function gregorianToJalali(dateValue) {
    if (!dateValue) return "";
    const parts = String(dateValue).slice(0, 10).split("-").map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return "";
    let [gy, gm, gd] = parts;
    if (gm < 1 || gm > 12 || gd < 1 || gd > 31) return "";
    const actualYear = gy;
    gy -= 1600; gm -= 1; gd -= 1;
    const gDayNo = 365 * gy + Math.floor((gy + 3) / 4) - Math.floor((gy + 99) / 100) + Math.floor((gy + 399) / 400);
    const leapYear = actualYear % 4 === 0 && (actualYear % 100 !== 0 || actualYear % 400 === 0);
    const gMonthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (gd + 1 > gMonthDays[gm]) return "";
    let dayNo = gDayNo;
    for (let i = 0; i < gm; i++) dayNo += gMonthDays[i];
    dayNo += gd;
    let jDayNo = dayNo - 79;
    let jy = 979 + 33 * Math.floor(jDayNo / 12053);
    jDayNo %= 12053;
    jy += 4 * Math.floor(jDayNo / 1461);
    jDayNo %= 1461;
    if (jDayNo >= 366) { jy += Math.floor((jDayNo - 1) / 365); jDayNo = (jDayNo - 1) % 365; }
    const jm = jDayNo < 186 ? 1 + Math.floor(jDayNo / 31) : 7 + Math.floor((jDayNo - 186) / 30);
    const jd = 1 + (jDayNo < 186 ? jDayNo % 31 : (jDayNo - 186) % 30);
    return `${jy}/${String(jm).padStart(2, "0")}/${String(jd).padStart(2, "0")}`;
  }

  function isValidJalaliDate(input) {
    const normalized = normalizeDigits(input).replace(/-/g, "/").trim();
    const converted = jalaliToGregorian(normalized);
    if (!converted) return false;
    const back = gregorianToJalali(converted);
    const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!match) return false;
    const canonical = `${match[1]}/${String(Number(match[2])).padStart(2, "0")}/${String(Number(match[3])).padStart(2, "0")}`;
    return back === canonical;
  }

  function localDateTimeToIso(value) {
    const normalized = String(value || "").trim();
    if (!normalized) return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(normalized)) {
      throw new RangeError("Invalid local date-time format");
    }
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) throw new RangeError("Invalid local date-time");
    const [datePart, timePart] = normalized.split("T");
    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute, second = 0] = timePart.split(":").map(Number);
    if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day ||
        date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) {
      throw new RangeError("Invalid local date-time");
    }
    return date.toISOString();
  }

  const api = { normalizeDigits, isValidIranianNationalCode, jalaliToGregorian, gregorianToJalali, isValidJalaliDate, localDateTimeToIso };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.DadbanFormValidation = api;
})(typeof window !== "undefined" ? window : globalThis);
