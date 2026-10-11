/*
 * Allergen rules engine for the Hard Rock Cafe Dublin staff guide.
 *
 * Pure functions only: no DOM access. Used by the staff page, the manager
 * page (window.AllergenRules) and the Netlify functions (require/import).
 *
 * SAFETY: any change here changes what staff are told about a dish.
 * Run `npm test` from the repository root after every edit.
 */
(function (root) {
  "use strict";

  /** The 14 EU allergens, in display order. */
  var ALLERGENS = [
    "Egg", "Milk", "Gluten", "Soy", "Peanuts", "Tree nuts", "Fish",
    "Crustaceans", "Molluscs", "Sesame", "Mustard", "Celery", "Lupin", "Sulphites",
  ];
  var DIETARY = ["Vegan", "Vegetarian"];

  /** Every filter staff can pick, in display order. */
  var ALL_FILTERS = ALLERGENS.concat(DIETARY);

  /** Filters shown before "More filters" is pressed. */
  var QUICK_FILTERS = ["Egg", "Milk", "Gluten", "Vegan", "Vegetarian", "Soy", "Tree nuts"];

  var KITCHEN_WARNING =
    "Cross-contamination warning: Items are prepared in a common kitchen that handles " +
    "gluten and other major allergens. We are not a certified 100% gluten-free kitchen.";

  /** Words staff may type in the restrictions box, mapped to canonical filters. */
  var RESTRICTION_ALIASES = {
    egg: ["Egg"], eggs: ["Egg"],
    dairy: ["Milk"], milk: ["Milk"],
    gluten: ["Gluten"], "gluten-free": ["Gluten"], "gluten free": ["Gluten"], gf: ["Gluten"], wheat: ["Gluten"],
    soy: ["Soy"], soya: ["Soy"],
    nuts: ["Peanuts", "Tree nuts"], nut: ["Peanuts", "Tree nuts"],
    "tree nuts": ["Tree nuts"], peanut: ["Peanuts"], peanuts: ["Peanuts"],
    fish: ["Fish"],
    shellfish: ["Crustaceans", "Molluscs"], crustaceans: ["Crustaceans"], molluscs: ["Molluscs"],
    sesame: ["Sesame"], mustard: ["Mustard"], celery: ["Celery"], lupin: ["Lupin"],
    sulphites: ["Sulphites"], sulfites: ["Sulphites"],
    vegan: ["Vegan"], vg: ["Vegan"],
    vegetarian: ["Vegetarian"], v: ["Vegetarian"],
  };

  /** Extra suggestions offered in the restrictions box besides ALL_FILTERS. */
  var EXTRA_SUGGESTIONS = ["Gluten-Free", "Dairy", "citrus", "lime", "lemon", "pineapple", "garlic", "mushroom", "soya"];

  /** Words that expand to several ingredient keywords when searching recipes. */
  var INGREDIENT_SYNONYMS = {
    citrus: ["lime", "lemon", "orange", "grapefruit", "yuzu", "mandarin", "tangerine", "pomelo", "bergamot", "citrus", "curacao", "cointreau"],
    citruses: ["citrus"],
    limes: ["lime"],
    lemons: ["lemon"],
    oranges: ["orange"],
    pineapples: ["pineapple"],
    mushrooms: ["mushroom"],
    chilli: ["chili", "chilli"],
    cilantro: ["cilantro", "coriander"],
    coriander: ["cilantro", "coriander"],
    soya: ["soy", "soya"],
    wheat: ["wheat", "gluten"],
    dairy: ["milk", "butter", "cream", "cheese", "buttermilk", "sour cream"],
    egg: ["egg", "mayonnaise", "mayo"],
    nuts: ["nut", "almond", "cashew", "hazelnut", "peanut", "pecan", "pistachio", "walnut"],
    shellfish: ["prawn", "shrimp", "crab", "lobster", "mollusc", "mussel", "oyster"],
  };

  /**
   * Ingredient words that point at an allergen. Used to show staff which
   * ingredient carries a recorded allergen, and by the manager page and the
   * recipe importer to spot allergens a recipe implies but the dish does not
   * record. `level: "possible"` means "often contains; check the label".
   * `unless` phrases are removed before matching (e.g. "oyster mushroom").
   */
  var DETECTION_RULES = [
    { allergen: "Gluten", words: ["gluten", "wheat", "flour", "bread", "breadcrumb", "breaded", "breading", "panko", "bun", "brioche", "crouton", "pasta", "macaroni", "noodle", "spaghetti", "barley", "rye", "spelt", "semolina", "couscous", "bulgur", "seitan", "malt", "batter", "battered", "cracker", "biscuit", "pastry", "brownie", "cookie", "cake", "waffle", "pancake", "tortilla", "wrap", "soy sauce", "beer", "ale", "stout", "lager", "guinness"],
      unless: ["gluten free bun", "gluten free vegan bun", "gluten free bread", "gluten free pasta", "gluten free wrap", "gluten free", "corn tortilla", "rice noodle", "buckwheat", "ginger beer", "root beer"] },
    { allergen: "Gluten", level: "possible", words: ["oat", "oats", "oat fibre", "oat fiber"] },
    { allergen: "Egg", words: ["egg", "eggs", "mayonnaise", "mayo", "aioli", "meringue", "custard", "hollandaise", "bearnaise", "brioche", "albumen", "caesar dressing"],
      unless: ["egg-free", "egg free", "vegan mayo", "vegan mayonnaise", "vegan aioli", "vegan garlic aioli"] },
    { allergen: "Milk", words: ["milk", "butter", "buttermilk", "cream", "cheese", "cheddar", "parmesan", "mozzarella", "feta", "brie", "romano", "monterey jack", "pepper jack", "queso", "ricotta", "mascarpone", "yogurt", "yoghurt", "ghee", "whey", "casein", "lactose", "creme fraiche", "gelato", "ice cream", "bechamel"],
      unless: ["butter alternative", "vegan butter", "peanut butter", "cocoa butter", "coconut milk", "coconut cream", "oat milk", "almond milk", "soy milk", "soya milk", "vegan cheese", "dairy-free", "dairy free", "cream of tartar"] },
    { allergen: "Milk", level: "possible", words: ["ranch", "milk chocolate", "chocolate", "caramel", "fudge"],
      unless: ["house ranch seasoning"] },
    { allergen: "Soy", words: ["soy", "soya", "soybean", "soy sauce", "tofu", "edamame", "miso", "tamari", "tempeh", "soy lecithin"] },
    { allergen: "Peanuts", words: ["peanut", "groundnut", "satay", "peanut butter"] },
    { allergen: "Tree nuts", words: ["tree nut", "almond", "cashew", "hazelnut", "pecan", "pistachio", "walnut", "macadamia", "brazil nut", "praline", "marzipan", "frangipane", "nutella"] },
    { allergen: "Tree nuts", level: "possible", words: ["disaronno", "amaretto", "frangelico", "nocino"] },
    { allergen: "Fish", words: ["fish", "anchovy", "anchovies", "cod", "haddock", "salmon", "tuna", "pollock", "hake", "sardine", "mackerel", "worcestershire", "fish sauce", "caesar dressing"] },
    { allergen: "Crustaceans", words: ["crustacean", "prawn", "shrimp", "crab", "lobster", "langoustine", "crayfish", "scampi"] },
    { allergen: "Molluscs", words: ["mollusc", "mussel", "oyster", "clam", "squid", "calamari", "octopus", "scallop", "snail", "oyster sauce"],
      unless: ["oyster mushroom"] },
    { allergen: "Sesame", words: ["sesame", "tahini", "hummus", "houmous"] },
    { allergen: "Mustard", words: ["mustard", "dijon", "dijonnaise"] },
    { allergen: "Celery", words: ["celery", "celeriac", "celery salt"] },
    { allergen: "Lupin", words: ["lupin", "lupini"] },
    { allergen: "Sulphites", words: ["sulphite", "sulfite", "sulphur dioxide", "sulfur dioxide", "metabisulphite"] },
    { allergen: "Sulphites", level: "possible", words: ["wine", "vinegar", "prosecco", "champagne", "cider", "dried fruit", "raisin", "sultana", "vermouth", "port", "sherry", "molasses"] },
  ];

  var SEPARATOR = /[,;\n]+/;
  var COATING = /(breaded|breading|panko|batter|battered|flour[- ]coated|coating)/i;

  function unique(list) {
    return Array.from(new Set(list));
  }

  function splitTokens(text) {
    return text.split(SEPARATOR).map(function (t) { return t.trim(); }).filter(Boolean);
  }

  /** Lower-case, strip accents and punctuation so "Curaçao" matches "curacao". */
  function normalise(text) {
    return String(text)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  // Detection words are normalised once, up front.
  var COMPILED_RULES = DETECTION_RULES.map(function (rule) {
    return {
      allergen: rule.allergen,
      level: rule.level || "contains",
      words: rule.words.map(function (w) { return { raw: w, n: normalise(w) }; }),
      unless: (rule.unless || []).map(function (u) { return " " + normalise(u) + " "; }),
    };
  });

  function containsWord(padded, w) {
    return padded.includes(" " + w + " ") || padded.includes(" " + w + "s ") || padded.includes(" " + w + "es ");
  }

  var detectionCache = new Map();

  // Words after "may contain" or "traces of" only make the allergen possible,
  // e.g. "Glaze (may contain egg)" or "Chocolate chips, may contain tree nuts".
  var MAY_CONTAIN = / (?:may contain|traces of) /;

  function matchRule(rule, text) {
    rule.unless.forEach(function (phrase) { text = text.split(phrase).join(" ~ "); });
    return rule.words.find(function (w) { return containsWord(text, w.n); });
  }

  function detectInIngredient(ingredient) {
    var cached = detectionCache.get(ingredient);
    if (cached) return cached;
    var base = " " + normalise(ingredient) + " ";
    var cut = base.search(MAY_CONTAIN);
    var main = cut < 0 ? base : base.slice(0, cut + 1);
    var maybe = cut < 0 ? "" : base.slice(cut);
    var hits = [];
    COMPILED_RULES.forEach(function (rule) {
      var word = matchRule(rule, main);
      var level = rule.level;
      if (!word && maybe) { word = matchRule(rule, maybe); level = "possible"; }
      if (word) hits.push({ allergen: rule.allergen, level: level, ingredient: ingredient, word: word.raw });
    });
    if (detectionCache.size > 5000) detectionCache.clear();
    detectionCache.set(ingredient, hits);
    return hits;
  }

  /**
   * Allergens implied by a list of ingredient strings.
   * Returns [{ allergen, level: "contains"|"possible", ingredient, word }].
   */
  function detectAllergens(ingredients) {
    var hits = [];
    (ingredients || []).forEach(function (i) { hits.push.apply(hits, detectInIngredient(i)); });
    // A "contains" hit for an ingredient wins over a "possible" hit for the same one.
    return hits.filter(function (h) {
      return h.level === "contains" || !hits.some(function (o) {
        return o !== h && o.allergen === h.allergen && o.ingredient === h.ingredient && o.level === "contains";
      });
    });
  }

  /** Summary of detectAllergens(): { Egg: { level, ingredients: [...] }, ... }. */
  function detectedAllergenMap(ingredients) {
    var map = {};
    detectAllergens(ingredients).forEach(function (h) {
      var entry = map[h.allergen] || (map[h.allergen] = { level: "possible", ingredients: [] });
      if (h.level === "contains") entry.level = "contains";
      if (!entry.ingredients.includes(h.ingredient)) entry.ingredients.push(h.ingredient);
    });
    return map;
  }

  /**
   * Split the restrictions box into recognised filters (`found`) and
   * free-text ingredient terms (`unknown`), e.g. "gf, lime" →
   * { found: ["Gluten"], unknown: ["lime"] }.
   */
  function parseRestrictions(text) {
    var unknown = [];
    var found = [];
    text.toLowerCase().split(SEPARATOR).map(function (t) { return t.trim(); }).filter(Boolean)
      .forEach(function (token) {
        if (RESTRICTION_ALIASES[token]) found.push.apply(found, RESTRICTION_ALIASES[token]);
        else unknown.push(token);
      });
    return { found: unique(found), unknown: unknown };
  }

  /** Label shown to staff for a filter ("Gluten" reads as "Gluten-Free"). */
  function filterLabel(filter) {
    if (filter === "Gluten") return "Gluten-Free";
    if (filter === "Milk") return "Dairy";
    return filter;
  }

  /** Add or remove one filter from the restrictions text (quick-select chips). */
  function toggleRestriction(text, filter) {
    var tokens = splitTokens(text);
    if (!parseRestrictions(text).found.includes(filter)) {
      return tokens.concat(filterLabel(filter)).join(", ");
    }
    return tokens
      .flatMap(function (token) {
        var found = parseRestrictions(token).found;
        if (!found.includes(filter)) return [token];
        // "nuts" minus Peanuts leaves "Tree nuts", etc.
        return found.filter(function (f) { return f !== filter; }).map(filterLabel);
      })
      .join(", ");
  }

  /** Replace the word being typed with a picked suggestion. */
  function replaceLastRestriction(text, value) {
    var tokens = text.split(SEPARATOR).map(function (t) { return t.trim(); });
    tokens[tokens.length - 1] = value;
    return tokens.filter(Boolean).join(", ");
  }

  /** The partial word currently being typed in the restrictions box. */
  function lastRestrictionToken(text) {
    var tokens = text.split(SEPARATOR);
    return (tokens[tokens.length - 1] || "").trim();
  }

  /** Food-box suggestions: dish names and categories (3+ characters typed). */
  function foodSuggestions(dishes, food) {
    var query = food.trim().toLowerCase();
    if (query.length < 3) return [];
    var names = unique(dishes.flatMap(function (d) { return [d.name, d.category]; }));
    return names.filter(function (n) { return n.toLowerCase().includes(query); }).slice(0, 7);
  }

  /** Restrictions-box suggestions for the word being typed (3+ characters). */
  function restrictionSuggestions(text) {
    var last = lastRestrictionToken(text).toLowerCase();
    if (last.length < 3) return [];
    return unique(ALL_FILTERS.concat(EXTRA_SUGGESTIONS))
      .filter(function (s) { return s.toLowerCase() !== last && s.toLowerCase().includes(last); })
      .slice(0, 7);
  }

  /** Chef checks on a dish that apply to the selected filters. */
  function chefChecksFor(dish, selected) {
    return (dish.chefChecks || []).filter(function (c) {
      return c.allergens.some(function (a) { return selected.includes(a); });
    });
  }

  /**
   * Compare a dish's recorded allergens with the selected filters.
   *   conflicts: selected filters the dish contains (or fails, for Vegan/Vegetarian)
   *   uncertain: selected filters listed as possible or cross-contact
   *   status:    "contains" | "unknown" | "match"
   * "match" only means nothing selected is recorded; staff still confirm
   * with the kitchen.
   */
  function assessDish(dish, selected) {
    var possible = dish.possible || [];
    var crossContact = dish.crossContact || [];
    var conflicts = selected.filter(function (f) {
      if (f === "Vegan") return !dish.vegan;
      if (f === "Vegetarian") return !dish.vegetarian;
      return dish.contains.includes(f);
    });
    var uncertain = selected.filter(function (f) {
      return possible.includes(f) || crossContact.includes(f);
    });
    var allergenConflicts = conflicts.filter(function (c) { return !DIETARY.includes(c); });
    var status;
    if (allergenConflicts.length) status = "contains";
    else if (uncertain.length) status = "unknown";
    else if (conflicts.length) status = "contains";
    else status = "match";
    return { status: status, conflicts: conflicts, uncertain: uncertain };
  }

  function expandIngredientTerm(term) {
    var key = normalise(term) === "citruses" ? "citrus" : normalise(term);
    return INGREDIENT_SYNONYMS[key] || [key];
  }

  /** Recipe ingredients that match each free-text term (whole-word match). */
  function matchIngredients(dish, terms) {
    return terms.flatMap(function (term) {
      var words = expandIngredientTerm(term).filter(Boolean);
      var hits = (dish.ingredients || []).filter(function (ingredient) {
        var padded = " " + normalise(ingredient) + " ";
        return words.some(function (w) { return padded.includes(" " + w + " "); });
      });
      return hits.length ? [{ query: term, ingredients: hits }] : [];
    });
  }

  /** For each selected allergen the dish has, point at the ingredient(s) responsible. */
  function locateAllergens(dish, selected) {
    var possible = dish.possible || [];
    var detected = detectedAllergenMap(dish.ingredients);
    return selected
      .filter(function (f) { return dish.contains.includes(f) || possible.includes(f); })
      .map(function (allergen) {
        var isPossible = !dish.contains.includes(allergen);
        var hits = detected[allergen] ? detected[allergen].ingredients : [];
        var fallback = isPossible
          ? "May be present. The ingredient it comes from is not specified."
          : "Listed on the menu allergen chart. The ingredient it comes from is not specified.";
        return { allergen: allergen, possible: isPossible, identified: hits.length > 0, locations: hits.length ? hits : [fallback] };
      });
  }

  /**
   * Full evaluation of one dish for the current search.
   * `substitutes` are recipe changes that clear every conflict without leaving
   * a selected allergen behind. None are offered when free-text ingredients
   * are being searched, for coated items under a Gluten/Egg check, or for any
   * filter listed in the dish's `noChangesFor`.
   */
  function evaluateDish(dish, selected, terms) {
    var assessment = assessDish(dish, selected);
    var ingredientMatches = matchIngredients(dish, terms);
    var coated = COATING.test(dish.name + " " + dish.description + " " + (dish.ingredients || []).join(" "));
    var blocked =
      terms.length > 0 ||
      (coated && selected.some(function (f) { return f === "Gluten" || f === "Egg"; })) ||
      (dish.noChangesFor || []).some(function (f) { return selected.includes(f); });
    var substitutes = blocked ? [] : dish.modifications.filter(function (m) {
      return assessment.conflicts.length > 0 &&
        assessment.conflicts.every(function (c) { return m.resolves.includes(c); }) &&
        selected.every(function (f) { return !m.remaining.includes(f); }) &&
        selected.every(function (f) { return !(dish.possible || []).includes(f) || m.resolves.includes(f); });
    });
    var status = ingredientMatches.length
      ? "contains"
      : terms.length && assessment.status === "match" ? "unknown" : assessment.status;
    var chefChecks = chefChecksFor(dish, selected);
    // A "list under substitutes" chef check covers the selected allergens it names:
    // the dish is listed as an alternative (with the note) when every conflict is covered.
    var covered = unique(chefChecks
      .filter(function (c) { return c.showInSubstitutes; })
      .flatMap(function (c) { return c.allergens.filter(function (a) { return selected.includes(a); }); }));
    var chefListed = covered.length > 0 && !ingredientMatches.length &&
      assessment.conflicts.every(function (c) { return covered.includes(c); });
    return {
      status: status,
      conflicts: assessment.conflicts,
      uncertain: assessment.uncertain,
      ingredientMatches: ingredientMatches,
      allergenLocations: locateAllergens(dish, selected),
      substitutes: substitutes,
      chefChecks: chefChecks,
      chefListed: chefListed,
    };
  }

  /**
   * Run a search over the whole menu.
   *
   * If the food box text matches no dish and no restriction is set, it is
   * treated as a restriction instead (so typing "dairy" in the food box works).
   *
   * Returns:
   *   labels       every restriction/ingredient being checked
   *   selected     canonical filters; terms: free-text ingredients
   *   active       whether to show the two result tabs
   *   flagged      "Contains / check" tab: dishes that conflict or need checking
   *   alternatives "Probable substitutes" tab: dishes without a recorded conflict,
   *                with a recipe change that resolves it, or with a chef check
   *                that lists them here
   */
  function searchMenu(dishes, food, selectedFilters, freeTerms) {
    var query = food.trim().toLowerCase();
    var nameOrCategoryMatches = function (d) { return (d.name + " " + d.category).toLowerCase().includes(query); };
    var foodIsRestriction = !!query && !selectedFilters.length && !freeTerms.length && !dishes.some(nameOrCategoryMatches);
    var reparsed = foodIsRestriction ? parseRestrictions(query) : { found: [], unknown: [] };
    var selected = selectedFilters.concat(reparsed.found);
    var terms = freeTerms.concat(reparsed.unknown);
    var labels = selected.concat(terms);

    var matchesFood = function (d) {
      if (!query || foodIsRestriction) return true;
      return (d.name + " " + d.category + " " + d.description + " " + (d.ingredients || []).join(" "))
        .toLowerCase().includes(query);
    };
    var results = dishes.map(function (d) {
      var r = evaluateDish(d, selected, terms);
      r.dish = d;
      r.matchesFood = matchesFood(d);
      return r;
    });

    if (!labels.length) {
      return {
        labels: labels, selected: selected, terms: terms, active: !!query,
        flagged: results.filter(function (r) { return r.matchesFood; }),
        alternatives: query ? results.filter(function (r) { return !r.matchesFood; }) : [],
      };
    }

    var isFlagged = function (r) {
      return r.conflicts.length > 0 || r.uncertain.length > 0 || r.ingredientMatches.length > 0;
    };
    var flagged = results.filter(function (r) { return r.matchesFood && isFlagged(r); });
    var alternatives = results
      .filter(function (r) { return !isFlagged(r) || r.substitutes.length > 0 || r.chefListed; })
      .sort(function (a, b) {
        return Number(b.matchesFood) - Number(a.matchesFood) ||
          Number(b.substitutes.length > 0) - Number(a.substitutes.length > 0);
      });

    return { labels: labels, selected: selected, terms: terms, active: true, flagged: flagged, alternatives: alternatives };
  }

  var api = {
    ALLERGENS: ALLERGENS,
    DIETARY: DIETARY,
    ALL_FILTERS: ALL_FILTERS,
    QUICK_FILTERS: QUICK_FILTERS,
    KITCHEN_WARNING: KITCHEN_WARNING,
    normalise: normalise,
    detectAllergens: detectAllergens,
    detectedAllergenMap: detectedAllergenMap,
    parseRestrictions: parseRestrictions,
    filterLabel: filterLabel,
    toggleRestriction: toggleRestriction,
    replaceLastRestriction: replaceLastRestriction,
    foodSuggestions: foodSuggestions,
    restrictionSuggestions: restrictionSuggestions,
    assessDish: assessDish,
    matchIngredients: matchIngredients,
    locateAllergens: locateAllergens,
    evaluateDish: evaluateDish,
    searchMenu: searchMenu,
  };

  root.AllergenRules = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
