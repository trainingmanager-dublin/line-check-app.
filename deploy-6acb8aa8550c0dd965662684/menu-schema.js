/*
 * Menu data rules shared by the manager page and the server:
 *   - cleanDish():       whitelist, trim and validate a dish (the server's copy
 *                        is authoritative; the browser uses it for instant feedback)
 *   - reviewWarnings():  safety checks; red ones must be fixed before saving
 *   - addDetected():     records allergens that new ingredients bring in
 *   - suggestCategory(): picks a menu section from the dish name and ingredients
 *   - diffDish():        human-readable list of what changed
 *   - shared ingredients: sauces and components used on several dishes
 * Depends on rules.js (AllergenRules).
 */
(function (root) {
  "use strict";

  var R = root.AllergenRules || (typeof require === "function" ? require("./rules.js") : null);

  var LIMITS = {
    dishes: 400, id: 64, name: 120, category: 60, description: 800,
    ingredients: 80, ingredient: 700, modifications: 20, instruction: 700,
    chefChecks: 10, note: 500, crossContactNote: 500, evidence: 2000, notes: 2000,
    confirmedFree: 30, shared: 200, sharedName: 80, recipe: 600,
  };

  /** Fields that change what staff are told about allergens. */
  var SAFETY_FIELDS = ["contains", "possible", "crossContact", "ingredients", "modifications", "vegan", "vegetarian", "chefChecks", "noChangesFor"];

  var FIELD_LABELS = {
    name: "Name", category: "Category", description: "Description", vegan: "Vegan", vegetarian: "Vegetarian",
    contains: "Contains", possible: "May contain", crossContact: "Cross-contact", crossContactNote: "Cross-contact details",
    ingredients: "Ingredients", modifications: "Recipe changes", chefChecks: "Chef checks", noChangesFor: "No changes offered for",
    evidence: "Where the allergens come from", notes: "Kitchen notes", archived: "Archived",
  };

  var ANIMAL_ALLERGENS = ["Milk", "Egg", "Fish", "Crustaceans", "Molluscs"];
  var SEAFOOD = ["Fish", "Crustaceans", "Molluscs"];

  function ValidationError(errors) {
    this.name = "ValidationError";
    this.message = errors.join(" ");
    this.errors = errors;
  }
  ValidationError.prototype = Object.create(Error.prototype);

  /** Small stable hash (FNV-1a), the same in the browser and on the server. */
  function hash32(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }

  /** Collapse whitespace, drop control characters, enforce a maximum length. */
  function cleanText(value, max, label, errors, required) {
    if (value == null) value = "";
    if (typeof value !== "string") { errors.push(label + " must be text."); return ""; }
    // eslint-disable-next-line no-control-regex
    var text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "")
      .replace(/[ \t]+/g, " ").replace(/\r\n?/g, "\n").trim();
    if (required && !text) errors.push(label + " is required.");
    if (text.length > max) errors.push(label + " is too long (max " + max + " characters).");
    return text;
  }

  function cleanList(value, allowed, label, errors) {
    if (value == null) return [];
    if (!Array.isArray(value)) { errors.push(label + " must be a list."); return []; }
    var out = [];
    value.forEach(function (v) {
      if (!allowed.includes(v)) errors.push(label + ": unknown value “" + String(v).slice(0, 40) + "”.");
      else if (!out.includes(v)) out.push(v);
    });
    // Keep the standard display order.
    return allowed.filter(function (a) { return out.includes(a); });
  }

  function cleanBool(value, label, errors) {
    if (value == null) return false;
    if (typeof value !== "boolean") { errors.push(label + " must be true or false."); return false; }
    return value;
  }

  function orderAllergens(list) {
    return R.ALLERGENS.filter(function (a) { return list.includes(a); });
  }

  // ---------- Shared ingredients ----------
  // A dish ingredient such as "Barbecue sauce (Ketchup, Mustard, …)" is
  // linked to the shared ingredient whose name matches the text before the
  // bracket. Saving a shared ingredient rewrites it on every linked dish.

  /** "Barbecue sauce (Ketchup, …)" → "Barbecue sauce". */
  function baseName(text) {
    return String(text).replace(/\s*[(\[][\s\S]*$/, "").trim();
  }

  function sharedKey(text) {
    return R.normalise(baseName(text));
  }

  /** The text a linked ingredient has on every dish. */
  function sharedText(entry) {
    return entry.recipe ? entry.name + " (" + entry.recipe + ")" : entry.name;
  }

  /** "Barbecue sauce (Ketchup, …)" → { name, recipe }, or null when the brackets don't close at the end. */
  function splitShared(text) {
    var open = text.indexOf("(");
    if (open < 0) return { name: text.trim(), recipe: "" };
    if (!/\)\s*$/.test(text)) return null;
    var depth = 0;
    for (var i = open; i < text.length; i++) {
      if (text[i] === "(") depth++;
      if (text[i] === ")") depth--;
      if (depth === 0 && i < text.trim().length - 1) return null; // closes before the end
      if (depth < 0) return null;
    }
    if (depth !== 0) return null;
    return { name: text.slice(0, open).trim(), recipe: text.trim().slice(open + 1, -1).trim() };
  }

  function cleanShared(input, errors) {
    if (!input || typeof input !== "object" || Array.isArray(input)) { errors.push("Shared ingredient is invalid."); return null; }
    var name = cleanText(input.name, LIMITS.sharedName, "Name", errors, true).replace(/\n/g, " ");
    var recipe = cleanText(input.recipe, LIMITS.recipe, "Recipe", errors).replace(/\s*\n\s*/g, ", ").replace(/,\s*,/g, ",").replace(/^,|,$/g, "").trim();
    if (/[()[\]]/.test(name)) errors.push("Leave brackets out of the name; put the recipe in the recipe box.");
    if (name && name.length < 2) errors.push("Name is too short.");
    var depth = 0;
    for (var i = 0; i < recipe.length; i++) {
      if (recipe[i] === "(") depth++;
      if (recipe[i] === ")") depth--;
      if (depth < 0) break;
    }
    if (depth !== 0) errors.push("The brackets in the recipe don't match.");
    if (sharedText({ name: name, recipe: recipe }).length > LIMITS.ingredient) errors.push("Name and recipe together are too long (max " + LIMITS.ingredient + " characters).");
    var id = typeof input.id === "string" && /^s-[0-9a-f]{6,16}$/.test(input.id) ? input.id : null;
    return { id: id, name: name, recipe: recipe };
  }

  /**
   * Starting list of shared ingredients: sauces and components with a recipe
   * in brackets that appear on two or more dishes. Ids are derived from the
   * name so the list is the same every time it is built.
   */
  function initialShared(dishes) {
    var groups = new Map();
    dishes.forEach(function (d) {
      (d.ingredients || []).forEach(function (text) {
        var key = sharedKey(text);
        if (!key) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(text);
      });
    });
    var out = [];
    groups.forEach(function (texts, key) {
      if (texts.length < 2) return;
      var counts = new Map();
      texts.forEach(function (t) { counts.set(t, (counts.get(t) || 0) + 1); });
      var best = Array.from(counts.keys()).sort(function (a, b) { return counts.get(b) - counts.get(a) || b.length - a.length; })[0];
      var parts = splitShared(best);
      if (!parts || parts.recipe.indexOf(",") < 0) return; // single products such as "Red Bull (as supplied)"
      out.push({ id: "s-" + hash32("shared:" + key), name: parts.name, recipe: parts.recipe });
    });
    return out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  // Lookups are cached per list; the lists are replaced, never edited in place.
  var indexCache = new WeakMap();

  function sharedIndex(shared) {
    var list = shared || [];
    var cached = indexCache.get(list);
    if (cached && cached.size === list.length) return cached.map;
    var map = new Map();
    list.forEach(function (s) { map.set(R.normalise(s.name), s); });
    indexCache.set(list, { size: list.length, map: map });
    return map;
  }

  /** The shared ingredient an ingredient line is linked to, if any. */
  function linkedShared(text, shared) {
    return sharedIndex(shared).get(sharedKey(text)) || null;
  }

  // ---------- Dishes ----------

  /** Key for a kitchen confirmation that an allergen the ingredients suggest is not in the dish. */
  function confirmKey(allergen, ingredients) {
    return allergen + "|" + hash32(ingredients.map(R.normalise).sort().join(";"));
  }

  /**
   * Return a clean copy of `input` containing only known fields.
   * Throws ValidationError listing every problem found.
   */
  function cleanDish(input) {
    var errors = [];
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError(["Dish must be an object."]);
    var id = typeof input.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id) ? input.id : null;
    if (!id) errors.push("Dish id is missing or invalid.");

    var ingredients = input.ingredients == null ? [] : input.ingredients;
    if (!Array.isArray(ingredients)) { errors.push("Ingredients must be a list."); ingredients = []; }
    if (ingredients.length > LIMITS.ingredients) errors.push("Too many ingredients (max " + LIMITS.ingredients + ").");
    ingredients = ingredients.slice(0, LIMITS.ingredients + 1)
      .map(function (i, n) { return cleanText(i, LIMITS.ingredient, "Ingredient " + (n + 1), errors).replace(/\s*\n\s*/g, " "); })
      .filter(Boolean);

    var mods = input.modifications == null ? [] : input.modifications;
    if (!Array.isArray(mods)) { errors.push("Recipe changes must be a list."); mods = []; }
    if (mods.length > LIMITS.modifications) errors.push("Too many recipe changes (max " + LIMITS.modifications + ").");
    mods = mods.slice(0, LIMITS.modifications + 1).map(function (m, n) {
      var label = "Recipe change " + (n + 1);
      if (!m || typeof m !== "object") { errors.push(label + " is invalid."); return null; }
      var mod = {
        instruction: cleanText(m.instruction, LIMITS.instruction, label, errors, true),
        resolves: cleanList(m.resolves, R.ALL_FILTERS, label + " removes", errors),
        remaining: cleanList(m.remaining, R.ALL_FILTERS, label + " still contains", errors),
      };
      if (!mod.resolves.length) errors.push(label + ": choose at least one allergen it removes.");
      mod.resolves.forEach(function (a) {
        if (mod.remaining.includes(a)) errors.push(label + ": " + a + " cannot be both removed and still there.");
      });
      return mod;
    }).filter(Boolean);

    var checks = input.chefChecks == null ? [] : input.chefChecks;
    if (!Array.isArray(checks)) { errors.push("Chef checks must be a list."); checks = []; }
    if (checks.length > LIMITS.chefChecks) errors.push("Too many chef checks (max " + LIMITS.chefChecks + ").");
    checks = checks.slice(0, LIMITS.chefChecks + 1).map(function (c, n) {
      var label = "Chef check " + (n + 1);
      if (!c || typeof c !== "object") { errors.push(label + " is invalid."); return null; }
      var check = {
        allergens: cleanList(c.allergens, R.ALL_FILTERS, label, errors),
        note: cleanText(c.note, LIMITS.note, label + " note", errors, true),
        showInSubstitutes: cleanBool(c.showInSubstitutes, label + " option", errors),
      };
      if (!check.allergens.length) errors.push(label + ": choose at least one allergy it applies to.");
      return check;
    }).filter(Boolean);

    var confirmed = input.confirmedFree == null ? [] : input.confirmedFree;
    if (!Array.isArray(confirmed)) { errors.push("Kitchen confirmations must be a list."); confirmed = []; }
    confirmed = confirmed.filter(function (k) {
      return typeof k === "string" && /^[A-Za-z ]{3,12}\|[0-9a-f]{8}$/.test(k) && R.ALLERGENS.includes(k.split("|")[0]);
    }).slice(0, LIMITS.confirmedFree);

    var dish = {
      id: id,
      name: cleanText(input.name, LIMITS.name, "Name", errors, true).replace(/\n/g, " "),
      category: cleanText(input.category, LIMITS.category, "Category", errors, true).replace(/\n/g, " "),
      description: cleanText(input.description, LIMITS.description, "Description", errors),
      vegan: cleanBool(input.vegan, "Vegan", errors),
      vegetarian: cleanBool(input.vegetarian, "Vegetarian", errors),
      contains: cleanList(input.contains, R.ALLERGENS, "Contains", errors),
      possible: cleanList(input.possible, R.ALLERGENS, "May contain", errors),
      crossContact: cleanList(input.crossContact, R.ALLERGENS, "Cross-contact", errors),
      crossContactNote: cleanText(input.crossContactNote, LIMITS.crossContactNote, "Cross-contact details", errors),
      ingredients: ingredients,
      modifications: mods,
      chefChecks: checks,
      noChangesFor: cleanList(input.noChangesFor, R.ALL_FILTERS, "No changes offered for", errors),
      evidence: cleanText(input.evidence, LIMITS.evidence, "Where the allergens come from", errors),
      notes: cleanText(input.notes, LIMITS.notes, "Kitchen notes", errors),
      archived: cleanBool(input.archived, "Archived", errors),
      confirmedFree: [],
    };
    if (dish.vegan && !dish.vegetarian) errors.push("A vegan dish must also be marked vegetarian.");
    dish.possible = dish.possible.filter(function (a) { return !dish.contains.includes(a); });

    // A recipe change still leaves every recorded allergen it doesn't remove,
    // plus anything the swap itself brings in (kept from `remaining`).
    var recorded = dish.contains.concat(dish.possible);
    dish.modifications.forEach(function (m) {
      m.remaining = R.ALL_FILTERS.filter(function (a) {
        if (m.resolves.includes(a)) return false;
        return m.remaining.includes(a) || recorded.includes(a);
      });
    });

    // Keep only confirmations that still match an allergen the ingredients suggest.
    var detected = R.detectedAllergenMap(dish.ingredients);
    var live = Object.keys(detected).filter(function (a) { return !recorded.includes(a); })
      .map(function (a) { return confirmKey(a, detected[a].ingredients); });
    dish.confirmedFree = confirmed.filter(function (k, i) { return live.includes(k) && confirmed.indexOf(k) === i; });

    if (errors.length) throw new ValidationError(errors);
    return dish;
  }

  /** Validate a whole menu document. */
  function cleanMenu(input) {
    if (!input || typeof input !== "object" || !Array.isArray(input.dishes)) {
      throw new ValidationError(["The menu must contain a list of dishes."]);
    }
    if (input.dishes.length > LIMITS.dishes) throw new ValidationError(["Too many dishes (max " + LIMITS.dishes + ")."]);
    var errors = [];
    var ids = new Set();
    var dishes = input.dishes.map(function (d, n) {
      try {
        var dish = cleanDish(d);
        if (ids.has(dish.id)) errors.push("Duplicate dish id " + dish.id + ".");
        ids.add(dish.id);
        return dish;
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        errors.push("Dish " + (n + 1) + " (" + String((d && d.name) || "unnamed").slice(0, 60) + "): " + e.errors.join(" "));
        return null;
      }
    });
    if (errors.length) throw new ValidationError(errors.slice(0, 30));
    return {
      title: cleanText(input.title, 120, "Title", errors) || "Dublin menu",
      dishes: dishes,
    };
  }

  function isBlank(v) {
    return v == null || v === "" || v === false || (Array.isArray(v) && !v.length);
  }

  /** Equal values; a missing field counts as equal to its empty default (older saved menus). */
  function sameValue(a, b) {
    if (isBlank(a) && isBlank(b)) return true;
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * A field's value for comparing two versions. A recipe change's "still
   * contains" list follows the dish's allergens, so only the instruction,
   * what it takes out and what the swap brings in are compared.
   */
  function compared(dish, f) {
    if (f !== "modifications") return dish[f];
    var recorded = (dish.contains || []).concat(dish.possible || []);
    return (dish.modifications || []).map(function (m) {
      var resolves = m.resolves || [];
      return { instruction: m.instruction, resolves: resolves,
        adds: (m.remaining || []).filter(function (a) { return !recorded.includes(a) && !resolves.includes(a); }) };
    });
  }

  /** True when a change affects what staff are told about allergens. */
  function isSafetyChange(before, after) {
    if (!before || !after) return true;
    return SAFETY_FIELDS.some(function (f) { return !sameValue(compared(before, f), compared(after, f)); });
  }

  function listText(v) {
    if (Array.isArray(v)) {
      if (!v.length) return "none";
      if (typeof v[0] === "object") return v.length + " item" + (v.length === 1 ? "" : "s");
      return v.join(", ");
    }
    if (typeof v === "boolean") return v ? "Yes" : "No";
    return v ? String(v) : "empty";
  }

  /** What changed between two versions of a dish. */
  function diffDish(before, after) {
    if (!before) return [{ field: "new", label: "New dish", before: "", after: after.name, safety: true }];
    if (!after) return [{ field: "removed", label: "Deleted", before: before.name, after: "", safety: true }];
    var out = [];
    Object.keys(FIELD_LABELS).forEach(function (f) {
      if (sameValue(compared(before, f), compared(after, f))) return;
      var entry = { field: f, label: FIELD_LABELS[f], before: listText(before[f]), after: listText(after[f]), safety: SAFETY_FIELDS.includes(f) };
      if (f === "ingredients") {
        entry.added = after.ingredients.filter(function (i) { return !(before.ingredients || []).includes(i); });
        entry.removed = (before.ingredients || []).filter(function (i) { return !after.ingredients.includes(i); });
      }
      if (["contains", "possible", "crossContact"].includes(f)) {
        entry.added = (after[f] || []).filter(function (a) { return !(before[f] || []).includes(a); });
        entry.removed = (before[f] || []).filter(function (a) { return !(after[f] || []).includes(a); });
      }
      out.push(entry);
    });
    return out;
  }

  /** Short ingredient name for messages: the text before any bracket. */
  function shortName(text) {
    var base = baseName(text);
    return base.length > 60 ? base.slice(0, 57) + "…" : base;
  }

  /**
   * Safety checks. Each warning:
   *   { level: "danger"|"warning"|"info", message, allergen?, key?, fix? }
   * "danger" warnings must be fixed (or confirmed by the kitchen, where that
   * is possible) before the dish can be saved.
   */
  function reviewWarnings(dish) {
    var out = [];
    var recorded = dish.contains.concat(dish.possible);
    var detected = R.detectedAllergenMap(dish.ingredients);
    var confirmed = dish.confirmedFree || [];

    Object.keys(detected).forEach(function (allergen) {
      var d = detected[allergen];
      if (recorded.includes(allergen)) return;
      var where = d.ingredients.slice(0, 2).map(shortName).join(", ");
      var key = confirmKey(allergen, d.ingredients);
      if (confirmed.includes(key)) {
        out.push({ level: "info", allergen: allergen, key: key, confirmed: true,
          message: "Kitchen confirmed: no " + allergen + " (" + where + ")." });
      } else if (d.level === "contains") {
        out.push({ level: "danger", allergen: allergen, key: key,
          message: where + " suggests " + allergen + ", but it isn't recorded.",
          fix: { action: "contains", allergen: allergen } });
      } else {
        out.push({ level: "warning", allergen: allergen, key: key,
          message: allergen + " is often in " + where + ". Check the label.",
          fix: { action: "possible", allergen: allergen } });
      }
    });

    if (dish.vegan) {
      ANIMAL_ALLERGENS.forEach(function (a) {
        if (dish.contains.includes(a)) out.push({ level: "danger", message: "Marked vegan but contains " + a + ".", fix: { action: "notVegan" } });
      });
    }
    if (dish.vegetarian && dish.contains.some(function (a) { return SEAFOOD.includes(a); })) {
      out.push({ level: "danger", message: "Marked vegetarian but contains fish or shellfish.", fix: { action: "notVegetarian" } });
    }

    dish.modifications.forEach(function (m, n) {
      m.resolves.forEach(function (a) {
        if (R.ALLERGENS.includes(a) && !recorded.includes(a)) {
          out.push({ level: "warning", message: "Recipe change " + (n + 1) + " removes " + a + ", but the dish doesn't record " + a + "." });
        }
      });
    });

    dish.contains.forEach(function (a) {
      if (!detected[a] && dish.ingredients.length) {
        out.push({ level: "info", message: a + " is recorded but no ingredient explains it. That is fine for packaged products." });
      }
    });
    if (!dish.ingredients.length) out.push({ level: "warning", message: "No ingredients recorded yet." });
    return out;
  }

  /** Red warnings that block saving. */
  function openDangers(dish) {
    return reviewWarnings(dish).filter(function (w) { return w.level === "danger"; });
  }

  /**
   * Records the allergens that ingredients newly bring in (compared with
   * `beforeIngredients`): "contains" words add Contains, "check the label"
   * words add May contain. Never removes anything. A dish that now contains
   * an animal allergen stops being vegan (or vegetarian, for fish and
   * shellfish). Changes `dish` and returns what was added.
   */
  function addDetected(dish, beforeIngredients) {
    var before = R.detectedAllergenMap(beforeIngredients || []);
    var after = R.detectedAllergenMap(dish.ingredients);
    var added = [];
    var confirmed = dish.confirmedFree || [];
    Object.keys(after).forEach(function (a) {
      var now = after[a];
      var was = before[a];
      if (was && !(was.level === "possible" && now.level === "contains")) return;
      if (confirmed.includes(confirmKey(a, now.ingredients))) return;
      if (now.level === "contains") {
        if (dish.contains.includes(a)) return;
        dish.contains = orderAllergens(dish.contains.concat(a));
        dish.possible = dish.possible.filter(function (x) { return x !== a; });
        added.push({ allergen: a, level: "contains", ingredient: shortName(now.ingredients[0]) });
      } else {
        if (dish.contains.includes(a) || dish.possible.includes(a)) return;
        dish.possible = orderAllergens(dish.possible.concat(a));
        added.push({ allergen: a, level: "possible", ingredient: shortName(now.ingredients[0]) });
      }
    });
    if (dish.vegan && dish.contains.some(function (a) { return ANIMAL_ALLERGENS.includes(a); })) {
      dish.vegan = false;
      added.push({ diet: "Vegan" });
    }
    if (dish.vegetarian && dish.contains.some(function (a) { return SEAFOOD.includes(a); })) {
      dish.vegetarian = false;
      dish.vegan = false;
      added.push({ diet: "Vegetarian" });
    }
    return added;
  }

  /**
   * Records every allergen the ingredients clearly contain that isn't
   * recorded or confirmed absent by the kitchen (closes red "not recorded"
   * warnings). Used when a shared ingredient changes and nobody is looking
   * at each dish. Returns what was added.
   */
  function closeDangers(dish) {
    var added = [];
    reviewWarnings(dish).forEach(function (w) {
      if (w.level === "danger" && w.fix && w.fix.action === "contains" && !dish.contains.includes(w.allergen)) {
        dish.contains = orderAllergens(dish.contains.concat(w.allergen));
        dish.possible = dish.possible.filter(function (x) { return x !== w.allergen; });
        added.push({ allergen: w.allergen, level: "contains" });
      }
    });
    // Diet labels follow the allergens (same rule as addDetected).
    return added.concat(addDetected(dish, dish.ingredients));
  }

  /**
   * Rewrites every ingredient linked to a shared ingredient with the shared
   * text, then records allergens the new text brings in (compared with
   * `opts.beforeIngredients`, or the dish as it was). With
   * `opts.closeDangers` any red "not recorded" warning left is closed too.
   * Changes `dish`; returns { dish, changed, added }.
   */
  function applyShared(dish, shared, opts) {
    opts = opts || {};
    var index = sharedIndex(shared);
    var before = opts.beforeIngredients || dish.ingredients.slice();
    dish.ingredients = dish.ingredients.map(function (text) {
      var entry = index.get(sharedKey(text));
      return entry ? sharedText(entry) : text;
    });
    var changed = JSON.stringify(before) !== JSON.stringify(dish.ingredients);
    var added = changed ? addDetected(dish, before) : [];
    if (opts.closeDangers) added = added.concat(closeDangers(dish));
    return { dish: dish, changed: changed, added: added };
  }

  // ---------- Category ----------
  // Words in the dish name point at a menu section; the dishes already in
  // each section break ties and cover sections these words don't know about.
  // `only`: a section that matches only dishes with one of the words
  // (a smashed burger section needs "smash", zero-proof needs "zero" etc.).

  var CATEGORY_HINTS = [
    { words: ["smash", "smashed", "smashburger"], section: /smash/i, weight: 10, only: true },
    { words: ["burger", "cheeseburger"], section: /burger/i, weight: 8 },
    { words: ["wing", "nachos", "skin", "dipper", "platter", "starter", "bite", "calamari", "quesadilla", "shrimp", "prawn", "slider", "popper", "tacos"], section: /\bstarter|appeti|snack|nibble/i, weight: 6 },
    { words: ["steak", "striploin", "sirloin", "ribeye", "fillet", "fajita", "ribs", "salmon", "plate", "tender", "fish", "fish and chips", "entree", "main"], section: /\bentr|\bmain/i, weight: 5 },
    { words: ["salad", "bowl"], section: /salad|\bbowl/i, weight: 6 },
    { words: ["sandwich", "wrap", "sub", "club sandwich", "toastie", "panini", "roll", "melt", "hot dog"], section: /sandwich|\bwrap/i, weight: 7 },
    { words: ["fries", "ring", "mash", "mashed", "vegetable", "veg", "side", "coleslaw", "slaw", "corn", "potatoes", "upgrade", "bread"], section: /\bside/i, weight: 8 },
    { words: ["add on", "add-on", "addon", "extra"], section: /\badd/i, weight: 9 },
    { words: ["sauce", "mayo", "aioli", "dressing", "dip", "relish", "salsa", "gravy", "dijonnaise"], section: /sauce|\bdip|dressing/i, weight: 7 },
    { words: ["cheesecake", "brownie", "ice cream", "cobbler", "sundae", "cake", "pie", "dessert", "tart", "cookie", "pudding", "fudge", "crumble", "waffle"], section: /dessert|\bsweet/i, weight: 8 },
    { words: ["martini", "margarita", "rita", "mezarita", "mojito", "daiquiri", "spritz", "old fashioned", "mai tai", "zombie", "hurricane", "long island", "mule", "sangria", "bloody mary", "paloma", "cocktail", "punch", "colada", "negroni", "sour", "royale", "mama", "electric", "on the beach", "iced tea"], section: /cocktail/i, weight: 7 },
    { words: ["zero proof", "zero-proof", "alcohol free", "alcohol-free", "mocktail", "virgin", "lemonade", "cooler", "press", "nojito", "no alcohol"], section: /zero|mocktail|alcohol.?free|non.?alc/i, weight: 9, only: true },
    { words: ["beer", "lager", "ale", "stout", "ipa", "pilsner", "draught", "draft", "cider", "pint", "guinness", "beamish", "smithwicks", "heineken", "moretti", "coors", "rockshore", "hop house", "bulmers", "neck oil"], section: /\bbeer|draught|draft|\blager|\bale\b/i, weight: 6 },
    { words: ["seltzer", "bottle", "bottled", "claw", "corona", "budweiser", "peroni", "kopparberg", "smirnoff ice"], section: /bottle|seltzer/i, weight: 7 },
    { words: ["wine", "sauvignon", "chardonnay", "merlot", "shiraz", "cabernet", "pinot", "rose", "rosado", "prosecco", "champagne", "rioja", "malbec", "grigio", "blanc", "moet"], section: /\bwine|champagne|prosecco/i, weight: 8 },
    { words: ["coffee", "espresso", "americano", "cappuccino", "latte", "tea", "pepsi", "cola", "7up", "water", "juice", "red bull", "soda", "hot chocolate", "club orange", "mineral"], section: /\bsoft|coffee|\btea\b|drink/i, weight: 6 },
  ];
  // Ingredients that point at a section when the name doesn't say.
  var INGREDIENT_HINTS = [
    { words: ["beef patty", "patty", "bun", "brioche bun"], section: /burger/i, weight: 4 },
    { words: ["ribeye", "striploin", "sirloin", "fillet steak", "steak"], section: /\bentr|\bmain/i, weight: 4 },
    { words: ["ciabatta", "sourdough", "baguette", "bread roll", "tortilla wrap", "sandwich bread"], section: /sandwich|\bwrap/i, weight: 4 },
    { words: ["ice cream", "custard", "sponge", "meringue"], section: /dessert|\bsweet/i, weight: 3 },
  ];
  var ALCOHOL = /\b(rum|vodka|tequila|mezcal|gin|whiskey|whisky|bourbon|jack daniels|liqueur|triple sec|vermouth|aperol|cointreau|schnapps|brandy|cognac|prosecco|amaretto|disaronno|curacao|kahlua|wine|baileys)\b/;
  var STOP = ["the", "a", "an", "and", "with", "of", "on", "in", "our", "house", "classic", "original", "legendary", "famous", "hard", "rock"];

  function tokens(text) {
    return R.normalise(text || "").split(" ").filter(function (w) { return w && STOP.indexOf(w) < 0; })
      .map(function (w) { return w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w; });
  }

  function hasWord(padded, word) {
    var w = R.normalise(word);
    return padded.indexOf(" " + w + " ") >= 0 || padded.indexOf(" " + w + "s ") >= 0 || padded.indexOf(" " + w + "es ") >= 0;
  }

  /** Share of words in common: by the union (`whole`) or by the smaller list. */
  function overlap(a, b, whole) {
    if (!a.length || !b.length) return 0;
    var setB = new Set(b);
    var setA = new Set(a);
    var shared = 0;
    setA.forEach(function (t) { if (setB.has(t)) shared++; });
    return shared / (whole ? new Set(a.concat(b)).size : Math.min(setA.size, setB.size));
  }

  /**
   * Best menu section for a dish, chosen from the sections already used by
   * `dishes` (the dish itself is ignored). Returns "" when nothing fits well.
   */
  function suggestCategory(dish, dishes) {
    var others = (dishes || []).filter(function (d) { return !dish.id || d.id !== dish.id; });
    var sections = [];
    others.forEach(function (d) { if (d.category && sections.indexOf(d.category) < 0) sections.push(d.category); });
    var name = " " + R.normalise(dish.name || "") + " ";
    if (!sections.length || !name.trim()) return "";
    var desc = " " + R.normalise(dish.description || "") + " ";
    var drinkText = R.normalise((dish.description || "") + " " + (dish.ingredients || []).join(" "));
    var alcoholic = ALCOHOL.test(drinkText);
    var nameTokens = tokens(dish.name);
    var ingTokens = tokens((dish.ingredients || []).join(" "));
    var ingText = " " + R.normalise((dish.ingredients || []).join(" ")) + " ";
    var nameSaysWhere = CATEGORY_HINTS.some(function (hint) { return hint.words.some(function (w) { return hasWord(name, w); }); });

    var best = "";
    var bestScore = 0;
    sections.forEach(function (section) {
      var score = 0;
      CATEGORY_HINTS.forEach(function (hint) {
        if (!hint.section.test(section)) return;
        var inName = hint.words.some(function (w) { return hasWord(name, w); });
        var inDesc = !inName && hint.words.some(function (w) { return hasWord(desc, w); });
        if (inName) score += hint.weight;
        else if (inDesc) score += hint.weight / 2;
        else if (hint.only) score -= 6;
      });
      if (!nameSaysWhere) {
        INGREDIENT_HINTS.forEach(function (hint) {
          if (hint.section.test(section) && hint.words.some(function (w) { return hasWord(ingText, w); })) score += hint.weight;
        });
      }
      if (alcoholic && /cocktail/i.test(section) && !/zero|mocktail|alcohol.?free|non.?alc/i.test(section)) score += 5;
      if (alcoholic && /zero|mocktail|alcohol.?free|non.?alc|\bsoft/i.test(section)) score -= 8;
      var nameSim = 0;
      var ingSim = 0;
      others.forEach(function (d) {
        if (d.category !== section) return;
        var theirName = tokens(d.name + " " + d.category);
        nameSim = Math.max(nameSim, (overlap(nameTokens, theirName, true) + overlap(nameTokens, theirName, false)) / 2);
        var theirs = tokens((d.ingredients || []).join(" "));
        ingSim = Math.max(ingSim, (overlap(ingTokens, theirs, true) + overlap(ingTokens, theirs, false)) / 2);
      });
      score += nameSim * 5 + ingSim * 4;
      if (score > bestScore) { bestScore = score; best = section; }
    });
    return bestScore >= 1.5 ? best : "";
  }

  function newDishId() {
    var bytes = new Uint8Array(6);
    (root.crypto || globalThis.crypto).getRandomValues(bytes);
    return "d-" + Array.from(bytes, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  function newSharedId() {
    var bytes = new Uint8Array(6);
    (root.crypto || globalThis.crypto).getRandomValues(bytes);
    return "s-" + Array.from(bytes, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  var api = {
    LIMITS: LIMITS,
    SAFETY_FIELDS: SAFETY_FIELDS,
    FIELD_LABELS: FIELD_LABELS,
    ValidationError: ValidationError,
    hash32: hash32,
    cleanText: cleanText,
    cleanDish: cleanDish,
    cleanMenu: cleanMenu,
    cleanShared: cleanShared,
    orderAllergens: orderAllergens,
    isSafetyChange: isSafetyChange,
    sameValue: sameValue,
    diffDish: diffDish,
    reviewWarnings: reviewWarnings,
    openDangers: openDangers,
    addDetected: addDetected,
    confirmKey: confirmKey,
    baseName: baseName,
    sharedKey: sharedKey,
    sharedText: sharedText,
    splitShared: splitShared,
    initialShared: initialShared,
    linkedShared: linkedShared,
    applyShared: applyShared,
    closeDangers: closeDangers,
    suggestCategory: suggestCategory,
    newDishId: newDishId,
    newSharedId: newSharedId,
  };

  root.MenuSchema = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
