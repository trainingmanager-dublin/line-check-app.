/*
 * Staff allergen guide UI. Plain DOM, no framework or build step.
 * The published menu comes from /api/menu (managers publish it from
 * /manager/); all allergen logic lives in rules.js (window.AllergenRules).
 */
(function () {
  "use strict";

  var R = window.AllergenRules;
  var h = Dom.h, icon = Dom.icon, append = Dom.append, replace = Dom.replace;
  var menu = { title: "", updatedAt: null, dishes: [] };
  var dishes = [];
  var loadState = "loading"; // loading | live | fallback | failed

  var state = { food: "", restrictions: "", allFilters: false, tab: "contains", dish: null };

  function slug(text) {
    return "cat-" + R.normalise(text).replace(/ /g, "-");
  }

  // ---------- Static layout ----------

  var root = document.getElementById("root");

  var foodInput = h("input", {
    id: "food", type: "search", autocomplete: "off", spellcheck: "false",
    placeholder: "Search burgers, salads, sauces…",
    "aria-describedby": "food-hint",
  });
  var restrictionsInput = h("input", {
    id: "restrictions", type: "search", autocomplete: "off", spellcheck: "false",
    placeholder: "Try egg, lime, citrus, garlic…",
    "aria-describedby": "restrictions-hint",
  });
  var foodSuggestionsEl = h("div", { class: "suggestions", role: "group", "aria-label": "Food suggestions" });
  var restrictionSuggestionsEl = h("div", { class: "suggestions", role: "group", "aria-label": "Allergy and ingredient suggestions" });
  var chipsEl = h("div", { class: "quick-row", role: "group", "aria-label": "Quick select allergies" });
  var selectionEl = h("div", { class: "selection-line" });
  var alertsEl = h("div", { class: "alerts" });
  var headingEl = h("div", { class: "results-heading" });
  var resultsEl = h("div", { class: "results" });
  var liveEl = h("p", { class: "sr-only", "aria-live": "polite" });

  var sheetBody = h("div", { class: "sheet-body" });
  var sheet = h("dialog", { class: "sheet", "aria-labelledby": "sheet-title" },
    h("button", { class: "sheet-close", type: "button", "aria-label": "Close", onclick: closeDish }, icon("close", 20)),
    sheetBody);
  sheet.addEventListener("click", function (e) { if (e.target === sheet) closeDish(); });
  sheet.addEventListener("close", function () { state.dish = null; });

  var dishCountEl = h("span", { class: "topbar-meta" });
  var footerMetaEl = h("p", { class: "footer-meta" });
  var bannerEl = h("div", { class: "alerts" });

  append(root, [
    h("a", { class: "skip-link", href: "#search" }, "Skip to search"),
    h("header", { class: "topbar" },
      h("div", { class: "topbar-inner" },
        h("a", { class: "brand", href: "./", "aria-label": "Hard Rock Cafe Dublin staff guide home" },
          h("img", { src: "./hard-rock-logo.png", alt: "Hard Rock Cafe", width: "163", height: "100" }),
          h("span", { class: "brand-text" }, "DUBLIN", h("small", null, "Staff allergen guide"))),
        h("div", { class: "topbar-actions" },
          dishCountEl,
          h("a", { class: "manager-link", href: "./manager/", "aria-label": "Manager login" },
            icon("lock", 16), h("span", null, "Manager", h("span", { class: "manager-link-extra" }, " login")))))),
    h("main", { class: "staff-main", id: "main" },
      h("div", { class: "title-row" },
        h("div", null,
          h("p", { class: "eyebrow" }, h("i"), "Staff reference · Dublin kitchen"),
          h("h1", null, "Check the ", h("em", null, "details.")),
          h("p", { class: "intro" }, "Ingredients, allergens and simple recipe changes, all in one place."))),
      bannerEl,
      h("section", { class: "search-panel", id: "search", "aria-label": "Menu search" },
        h("div", { class: "section-label" }, icon("sliders", 16), "Make your check"),
        h("div", { class: "search-grid" },
          h("div", { class: "field-group" },
            h("label", { for: "food" }, "Food item or keyword"),
            h("div", { class: "input-wrap" }, icon("search", 20), foodInput),
            h("p", { class: "hint", id: "food-hint" }, "Dish, category or ingredient. Press / to jump here."),
            foodSuggestionsEl),
          h("div", { class: "field-group" },
            h("label", { for: "restrictions" }, "Allergies or dietary needs"),
            h("div", { class: "input-wrap" }, icon("shield", 20), restrictionsInput),
            h("p", { class: "hint", id: "restrictions-hint" }, "Separate several with commas, e.g. gluten, lime."),
            restrictionSuggestionsEl)),
        chipsEl,
        selectionEl),
      alertsEl,
      headingEl,
      liveEl,
      resultsEl,
      h("footer", { class: "site-footer" },
        h("p", null, h("strong", null, "Reference only. "),
          "This guide is based on our recipes and the menu allergen chart. It does not guarantee that a dish is safe. " +
          "Always confirm with the manager on duty and the kitchen before serving a guest with an allergy."),
        footerMetaEl)),
    sheet,
  ]);

  foodInput.addEventListener("input", function () { state.food = foodInput.value; update(); });
  restrictionsInput.addEventListener("input", function () { state.restrictions = restrictionsInput.value; update(); });

  document.addEventListener("keydown", function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === "/" && !typing && !sheet.open) {
      e.preventDefault();
      foodInput.focus();
    }
  });

  // ---------- State changes ----------

  function setFood(value) {
    state.food = foodInput.value = value;
    update();
  }

  function setRestrictions(value) {
    state.restrictions = restrictionsInput.value = value;
    update();
  }

  function openDish(dish, trigger) {
    state.dish = dish;
    state.trigger = trigger;
    renderSheet();
    if (!sheet.open) sheet.showModal();
    sheet.scrollTop = 0;
  }

  function closeDish() {
    if (sheet.open) sheet.close();
    if (state.trigger && document.contains(state.trigger)) state.trigger.focus();
  }

  function syncUrl() {
    var params = new URLSearchParams();
    if (state.food.trim()) params.set("food", state.food.trim());
    if (state.restrictions.trim()) params.set("check", state.restrictions.trim());
    var qs = params.toString();
    try {
      history.replaceState(null, "", qs ? "?" + qs : location.pathname);
    } catch (e) { /* file:// or sandboxed frames */ }
  }

  // ---------- Search view ----------

  var current;

  function update() {
    var parsed = R.parseRestrictions(state.restrictions);
    current = R.searchMenu(dishes, state.food, parsed.found, parsed.unknown);
    renderSuggestions();
    renderChips();
    renderSelection();
    renderAlerts();
    renderResults();
    if (state.dish) renderSheet();
    syncUrl();
  }

  function suggestionButtons(values, onPick) {
    return values.map(function (v) {
      return h("button", { type: "button", onclick: function () { onPick(v); } }, v);
    });
  }

  function renderSuggestions() {
    replace(foodSuggestionsEl, suggestionButtons(R.foodSuggestions(dishes, state.food), function (v) {
      setFood(v);
      foodInput.focus();
    }));
    replace(restrictionSuggestionsEl, suggestionButtons(R.restrictionSuggestions(state.restrictions), function (v) {
      setRestrictions(R.replaceLastRestriction(state.restrictions, v));
      restrictionsInput.focus();
    }));
  }

  function renderChips() {
    var filters = state.allFilters ? R.ALL_FILTERS : R.QUICK_FILTERS;
    replace(chipsEl,
      h("span", { class: "quick-label" }, "Quick select"),
      filters.map(function (f) {
        var on = current.selected.includes(f);
        return h("button", {
          type: "button", class: "chip" + (on ? " selected" : ""), "aria-pressed": on ? "true" : "false",
          onclick: function () { setRestrictions(R.toggleRestriction(state.restrictions, f)); },
        }, R.filterLabel(f));
      }),
      h("button", {
        type: "button", class: "text-button", "aria-expanded": state.allFilters ? "true" : "false",
        onclick: function () { state.allFilters = !state.allFilters; renderChips(); },
      }, state.allFilters ? "Fewer filters" : "More filters +"));
  }

  function renderSelection() {
    var hasInput = current.selected.length > 0 || state.restrictions || state.food;
    selectionEl.hidden = !hasInput;
    if (!hasInput) return;
    replace(selectionEl,
      h("span", null, current.labels.length
        ? ["Checking: ", h("strong", null, current.labels.map(R.filterLabel).join(" + "))]
        : "Separate restrictions with commas."),
      h("button", {
        type: "button", class: "text-button",
        onclick: function () {
          state.food = foodInput.value = "";
          state.restrictions = restrictionsInput.value = "";
          update();
          foodInput.focus();
        },
      }, "Clear search"));
  }

  function renderAlerts() {
    var items = [];
    if (current.selected.includes("Gluten")) {
      items.push(h("div", { class: "warning", role: "note" }, icon("alert", 20), h("p", null, R.KITCHEN_WARNING)));
    }
    if (current.terms.length) {
      items.push(h("div", { class: "notice" }, icon("info", 20),
        h("p", null, "Searching ingredients for ", h("strong", null, current.terms.join(", ")),
          ", including sauces, mixers and garnishes. If nothing is found, that does not guarantee it is absent.")));
    }
    replace(alertsEl, items);
  }

  function renderResults() {
    var labels = current.labels;
    var title = labels.length ? labels.map(R.filterLabel).join(" + ") + " check"
      : state.food.trim() ? "Menu matches" : "Explore the menu";
    var sub = labels.length ? "Dishes to avoid or check, and alternatives across the menu."
      : state.food.trim() ? "Add an allergy or ingredient to see which dishes suit the guest."
      : "Search a food, ingredient or allergy to compare options.";
    replace(headingEl, h("h2", null, title), h("p", null, sub));

    if (loadState === "loading") {
      replace(resultsEl, h("div", { class: "empty" }, h("p", null, "Loading the menu\u2026")));
      return;
    }
    if (!dishes.length) {
      replace(resultsEl, h("div", { class: "empty", role: "alert" },
        h("p", null, "The menu could not be loaded. Check the connection and try again."),
        h("button", { type: "button", class: "button", onclick: function () { location.reload(); } }, "Try again")));
      liveEl.textContent = "";
      return;
    }

    if (!current.active) {
      replace(resultsEl, exploreView());
      liveEl.textContent = "";
      return;
    }

    var tabs = [
      { id: "contains", label: labels.length ? "Contains / check" : "Matches", items: current.flagged, alt: false,
        intro: labels.length
          ? "Dishes that contain your selection or need a cross-contact check."
          : "Dishes matching your search. Add an allergy to see alternatives.",
        empty: "No dishes list this. That does not guarantee it is absent, so confirm with the kitchen." },
      { id: "substitutes", label: "Probable substitutes", items: current.alternatives, alt: true,
        intro: labels.length
          ? "Dishes with no listed conflict, or that can be adapted. Always confirm with the kitchen."
          : "Add the guest’s allergy or ingredient restriction to compare these options.",
        empty: "No alternatives found for this combination." },
    ];
    var active = tabs.find(function (t) { return t.id === state.tab; }) || tabs[0];

    var tabButtons = tabs.map(function (t) {
      var selected = t === active;
      return h("button", {
        type: "button", role: "tab", id: "tab-" + t.id, "aria-controls": "panel-" + t.id,
        "aria-selected": selected ? "true" : "false", tabindex: selected ? "0" : "-1",
        onclick: function () { state.tab = t.id; renderResults(); document.getElementById("tab-" + t.id).focus(); },
        onkeydown: function (e) {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          state.tab = tabs[(tabs.indexOf(t) + 1) % tabs.length].id;
          renderResults();
          document.getElementById("tab-" + state.tab).focus();
        },
      }, t.label, h("span", { class: "count" }, String(t.items.length)));
    });

    replace(resultsEl,
      h("div", { class: "result-tabs", role: "tablist", "aria-label": "Results" }, tabButtons),
      h("div", { role: "tabpanel", id: "panel-" + active.id, "aria-labelledby": "tab-" + active.id },
        h("p", { class: "tab-intro" }, active.intro),
        labels.length ? legend() : null,
        active.items.length ? grid(active.items, active.alt) : h("p", { class: "empty" }, active.empty)));

    liveEl.textContent = current.flagged.length + " flagged, " + current.alternatives.length + " probable substitutes.";
  }

  function exploreView() {
    var categories = [];
    var byCategory = {};
    current.flagged.forEach(function (r) {
      var c = r.dish.category;
      if (!byCategory[c]) { byCategory[c] = []; categories.push(c); }
      byCategory[c].push(r);
    });
    return [
      h("nav", { class: "category-nav", "aria-label": "Menu categories" },
        categories.map(function (c) {
          return h("a", { class: "chip", href: "#" + slug(c) }, c, h("span", { class: "count" }, String(byCategory[c].length)));
        })),
      categories.map(function (c) {
        return h("section", { class: "category-section", id: slug(c), "aria-labelledby": slug(c) + "-h" },
          h("h3", { class: "category-heading", id: slug(c) + "-h" }, c),
          grid(byCategory[c], false));
      }),
    ];
  }

  function legend() {
    return h("ul", { class: "legend", "aria-label": "Status key" },
      h("li", null, h("span", { class: "dot danger" }), "Contains / unsuitable"),
      h("li", null, h("span", { class: "dot caution" }), "Cross-contact / check"),
      h("li", null, h("span", { class: "dot change" }), "With changes"),
      h("li", null, h("span", { class: "dot neutral" }), "No conflict listed"));
  }

  /** Badge text and colour for a result card. Wording matches the original guide. */
  function badge(r, alt) {
    if (!current.labels.length) return { text: "View ingredients", tone: "neutral" };
    if (alt) {
      if (r.substitutes.length) return { text: "With changes", tone: "change" };
      if (r.chefListed && r.conflicts.length) return { text: "Check with chef", tone: "caution" };
      if (r.uncertain.length) return { text: "Cross-contact / check", tone: "caution" };
      return { text: "No conflict listed", tone: "neutral" };
    }
    if (r.ingredientMatches.length || r.status === "contains") return { text: "Contains / unsuitable", tone: "danger" };
    return { text: "Cross-contact / check", tone: "caution" };
  }

  /** "May contain soy; gluten cross-contact risk" for a dish's uncertain filters. */
  function uncertainText(dish, list) {
    var possible = dish.possible || [];
    return list.map(function (a) {
      return possible.includes(a) ? "May contain " + a.toLowerCase() : a + " cross-contact risk";
    }).join("; ");
  }

  /** "Contains egg, milk; not vegan" for a list of conflicts. */
  function conflictText(conflicts) {
    var allergens = conflicts.filter(function (c) { return !R.DIETARY.includes(c); });
    var diet = conflicts.filter(function (c) { return R.DIETARY.includes(c); });
    return [
      allergens.length ? "Contains " + allergens.join(", ").toLowerCase() : null,
      diet.length ? "Not " + diet.join(" or ").toLowerCase() : null,
    ].filter(Boolean).join("; ");
  }

  /** Ingredient name without its recipe in brackets: "Legendary Sauce (Mayonnaise…)" → "Legendary Sauce". */
  function shortIngredient(text) {
    return text.replace(/\s*\(.*$/, "");
  }

  function insight(r, alt) {
    if (alt && current.labels.length) {
      if (r.substitutes.length) return r.substitutes[0].instruction;
      if (r.chefListed && r.conflicts.length) return conflictText(r.conflicts) + " as served. Check with the chef before offering it.";
      if (r.chefListed) return uncertainText(r.dish, r.uncertain) + ". Check with the chef.";
      return "None of the selected allergens or ingredients is listed.";
    }
    if (r.ingredientMatches.length) {
      return "Contains " + r.ingredientMatches.map(function (m) { return m.query; }).join(", ");
    }
    if (current.labels.length && r.conflicts.length) {
      var parts = r.allergenLocations.map(function (l) {
        return (l.possible ? "May contain " + l.allergen.toLowerCase() : l.allergen) + ": " +
          (l.identified ? shortIngredient(l.locations[0]) : "listed on the menu");
      });
      r.conflicts.forEach(function (c) { if (c === "Vegan" || c === "Vegetarian") parts.push("Not " + c.toLowerCase()); });
      return parts.join(" · ");
    }
    if (r.uncertain.length) return uncertainText(r.dish, r.uncertain) + ". Check with the kitchen.";
    return null;
  }

  function dietTags(dish) {
    return [
      dish.vegan ? h("span", { class: "tag diet" }, "Vegan") : null,
      !dish.vegan && dish.vegetarian ? h("span", { class: "tag diet" }, "Vegetarian") : null,
    ];
  }

  function allergenTags(dish, selected) {
    return dish.contains.map(function (a) {
      var hit = selected.includes(a);
      return h("span", { class: "tag" + (hit ? " hit" : "") }, a);
    });
  }

  function grid(results, alt) {
    return h("div", { class: "dish-grid" }, results.map(function (r) { return card(r, alt); }));
  }

  function card(r, alt) {
    var d = r.dish;
    var b = badge(r, alt);
    var text = insight(r, alt);
    var el = h("button", { type: "button", class: "dish-card tone-" + b.tone },
      h("div", { class: "card-top" },
        h("span", { class: "category" }, d.category),
        h("span", { class: "status " + b.tone }, b.text)),
      h("h3", null, d.name),
      h("p", { class: "dish-desc" }, d.description),
      h("div", { class: "tags" }, dietTags(d), allergenTags(d, current.selected)),
      text ? h("p", { class: "card-insight" }, icon("info", 16), h("span", null, text)) : null,
      r.chefChecks.map(function (c) {
        return h("p", { class: "allergen-warning chef" }, icon("chef", 16), h("span", null, c.note));
      }),
      alt && r.substitutes.length > 0 && r.uncertain.length > 0
        ? h("p", { class: "mod-count" }, "Still check: " + uncertainText(d, r.uncertain)) : null,
      h("span", { class: "card-bottom" }, "Ingredients & changes", icon("chevron", 18)));
    el.addEventListener("click", function () { openDish(d, el); });
    return el;
  }

  // ---------- Dish detail sheet ----------

  function section(title, content) {
    return h("section", { class: "sheet-section" }, h("h3", null, title), content);
  }

  function renderSheet() {
    var d = state.dish;
    if (!d) return;
    var sel = current.selected;
    var r = R.evaluateDish(d, sel, current.terms);
    var highlighted = new Set();
    r.ingredientMatches.forEach(function (m) { m.ingredients.forEach(function (i) { highlighted.add(i); }); });
    r.allergenLocations.forEach(function (l) { l.locations.forEach(function (i) { highlighted.add(i); }); });

    var summary = null;
    if (current.labels.length) {
      var rows = [];
      if (r.conflicts.length) rows.push(["danger", "Unsuitable", conflictText(r.conflicts).toLowerCase()]);
      if (r.ingredientMatches.length) rows.push(["danger", "Ingredient found", r.ingredientMatches.map(function (m) { return m.query; }).join(", ")]);
      if (r.uncertain.length) rows.push(["caution", "Check", uncertainText(d, r.uncertain)]);
      if (r.chefChecks.length) rows.push(["caution", "Chef check", "see the note at the top"]);
      if (r.substitutes.length) rows.push(["change", "Can be adapted", r.substitutes.length === 1 ? "1 option below" : r.substitutes.length + " options below"]);
      if (!rows.length) rows.push(["neutral", "No conflict listed", "always confirm with the kitchen"]);
      summary = h("div", { class: "check-summary" },
        h("p", { class: "check-title" }, "Your check: " + current.labels.map(R.filterLabel).join(" + ")),
        h("ul", null, rows.map(function (row) {
          return h("li", null, h("span", { class: "dot " + row[0] }), h("b", null, row[1] + ": "), row[2]);
        })));
    }

    replace(sheetBody,
      h("header", { class: "sheet-header" },
        h("p", { class: "eyebrow" }, h("i"), d.category),
        h("h2", { id: "sheet-title" }, d.name),
        h("p", { class: "sheet-desc" }, d.description),
        h("div", { class: "tags" }, dietTags(d))),
      r.chefChecks.map(function (c) {
        return h("div", { class: "allergen-warning chef" }, icon("chef", 20),
          h("p", null, h("strong", null, "Check with the chef: "), c.note));
      }),
      sel.includes("Gluten") ? h("div", { class: "warning" }, icon("alert", 20), h("p", null, R.KITCHEN_WARNING)) : null,
      summary,
      section("Allergens", [
        d.contains.length
          ? h("div", { class: "tags" }, allergenTags(d, sel))
          : h("p", null, "None listed. Always confirm with the kitchen."),
        (d.possible || []).length ? h("p", { class: "muted" }, "May contain: " + d.possible.join(", ")) : null,
        r.allergenLocations.length
          ? h("ul", { class: "ingredient-list" }, r.allergenLocations.map(function (l) {
              return h("li", null, h("b", null, (l.possible ? "May contain " + l.allergen.toLowerCase() : l.allergen) + ": "), l.locations.join("; "));
            }))
          : null,
      ]),
      section("Ingredients", d.ingredients && d.ingredients.length
        ? [
            h("p", { class: "muted" }, "Includes sauces and sides. Packaged products can change, so check the label if unsure."),
            h("ul", { class: "ingredient-list" }, d.ingredients.map(function (i) {
              return h("li", null, highlighted.has(i) ? h("mark", null, i) : i);
            })),
          ]
        : h("p", null, "Ingredients have not been added yet.")),
      section("Cross-contact", d.crossContact && d.crossContact.length
        ? [
            h("div", { class: "tags" }, d.crossContact.map(function (a) { return h("span", { class: "tag" + (sel.includes(a) ? " hit" : "") }, a); })),
            h("p", null, d.crossContactNote || "Risk of cross-contact during preparation. Check with the kitchen."),
          ]
        : h("p", null, "No specific risk recorded. The kitchen handles all 14 allergens, so always tell the chef about the allergy.")),
      d.chefChecks && d.chefChecks.length
        ? section("Chef checks", h("ul", { class: "ingredient-list" }, d.chefChecks.map(function (c) {
            return h("li", null, h("b", null, c.allergens.map(R.filterLabel).join(", ") + ": "), c.note);
          })))
        : null,
      d.evidence ? section("Where the allergens come from", h("p", null, d.evidence)) : null,
      section("Probable substitutes", r.substitutes.length
        ? r.substitutes.map(function (m) {
            return h("div", { class: "modification" },
              h("p", { class: "mod-title" }, icon("swap", 16), h("b", null, m.instruction)),
              h("p", null, "Covers: " + m.resolves.join(", ") + ". Still contains: " + (m.remaining.join(", ") || "none listed") + "." +
                (d.crossContact && d.crossContact.length ? " The " + d.crossContact.join(", ").toLowerCase() + " cross-contact risk still applies." : "")));
          })
        : h("p", null, current.labels.length
            ? "No change covers every selected allergy. See the Probable substitutes tab for other dishes."
            : "Add an allergy above to see which changes apply.")),
      d.notes ? section("Kitchen notes", h("p", null, d.notes)) : null,
      h("p", { class: "sheet-footnote" }, "Reference only. Confirm with the manager on duty and the kitchen before serving."));
  }

  // ---------- Optional in-browser agent tool (WebMCP) ----------

  var modelContext = document.modelContext || navigator.modelContext;
  if (modelContext && modelContext.registerTool) {
    Promise.resolve(modelContext.registerTool({
      name: "set_menu_search",
      description: "Set the visible food and allergy filters. Results are for reference and do not guarantee food safety.",
      inputSchema: {
        type: "object",
        properties: { food: { type: "string" }, restrictions: { type: "string" } },
        required: ["food", "restrictions"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: async function (input) {
        if (typeof (input && input.food) !== "string" || typeof input.restrictions !== "string") {
          throw new Error("Both fields must be strings");
        }
        state.food = foodInput.value = input.food;
        state.restrictions = restrictionsInput.value = input.restrictions;
        update();
        var parsed = R.parseRestrictions(input.restrictions);
        return { food: input.food, restrictions: parsed.found, ingredients: parsed.unknown, referenceOnly: true };
      },
    })).catch(function () {});
  }

  // ---------- Start ----------

  function formatDate(iso) {
    var d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? d.toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric" }) : "";
  }

  function showMenu(data, source) {
    menu = data;
    dishes = (Array.isArray(data.dishes) ? data.dishes : []).filter(function (d) { return !d.archived; });
    loadState = source;
    replace(dishCountEl, icon("book", 16), dishes.length + " dishes");
    var when = formatDate(menu.updatedAt);
    footerMetaEl.textContent = source === "live"
      ? (when ? "Menu last updated " + when + "." : "")
      : "Built-in copy of the menu.";
    replace(bannerEl, source === "fallback"
      ? h("div", { class: "warning", role: "alert" }, icon("alert", 20),
          h("p", null, h("strong", null, "Offline copy. "),
            "The latest published menu could not be loaded, so this is the built-in copy and may be out of date. Check with a manager before relying on it."))
      : null);
    update();
  }

  function fetchJson(url) {
    return fetch(url, { credentials: "same-origin", cache: "no-cache" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  var params = new URLSearchParams(location.search);
  state.food = foodInput.value = params.get("food") || "";
  state.restrictions = restrictionsInput.value = params.get("check") || "";
  update();

  fetchJson("/api/menu")
    .then(function (data) { showMenu(data, "live"); })
    .catch(function () {
      return fetchJson("./data/menu-seed.json")
        .then(function (data) { showMenu(data, "fallback"); })
        .catch(function () { loadState = "failed"; update(); });
    });
})();
