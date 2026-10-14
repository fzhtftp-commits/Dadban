const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function createBrowser({ script, search = "", responses = [], initial = {}, csrf = "test-csrf" }) {
  const root = path.resolve(__dirname, "../..");
  const elements = new Map();
  const calls = [];
  const listeners = new Map();
  const makeElement = (id = "") => ({
    id, value: initial[id] ?? "", textContent: "", innerHTML: "", hidden: false, disabled: false,
    required: false, checked: false, href: "", className: "", type: "", name: "", style: {},
    classList: { add(){}, remove(){}, toggle(){} },
    addEventListener(type, fn) { const key = id + ":" + type; listeners.set(key, fn); },
    checkValidity() { return true; }, reportValidity(){}, focus(){},
    querySelector(){ return makeElement(id + ":child"); }
  });
  const get = id => { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); };
  const individual = makeElement("radio-individual"); individual.value = "individual"; individual.checked = true; individual.name = "clientType";
  const company = makeElement("radio-company"); company.value = "company"; company.checked = false; company.name = "clientType";
  const typeOptions = [makeElement("type-option-1"), makeElement("type-option-2")];
  typeOptions[0].querySelector = () => individual; typeOptions[1].querySelector = () => company;
  const document = {
    title: "",
    addEventListener(type, fn) { listeners.set("document:" + type, fn); },
    getElementById: get,
    querySelectorAll(selector) {
      if (selector === 'input[name="clientType"]') return [individual, company];
      if (selector === ".type-option") return typeOptions;
      return [];
    },
    querySelector(selector) {
      if (selector === 'input[name="clientType"]:checked') return company.checked ? company : individual;
      if (selector === 'input[name="clientType"][value="individual"]') return individual;
      if (selector === 'input[name="clientType"][value="company"]') return company;
      if (selector === "h1") return get("h1");
      return makeElement(selector);
    }
  };
  const window = { search, location: { search, href: "" }, DadbanFormValidation: require("../../form-validation.js") };
  const context = {
    document, window, location: window.location, URLSearchParams, console,
    sessionStorage: { getItem: key => key === "dadban_csrf" ? csrf : null },
    setTimeout: fn => { if (typeof fn === "function") return fn(); return 1; },
    clearTimeout(){},
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const next = responses.shift() || { status: 200, body: { data: { id: "mock-id" } } };
      return { status: next.status ?? 200, ok: (next.status ?? 200) >= 200 && (next.status ?? 200) < 300,
        json: async () => next.body ?? {} };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, script), "utf8"), context, { filename: script });
  return { document, window, elements, calls, listeners, individual, company, get };
}
module.exports = { createBrowser };
