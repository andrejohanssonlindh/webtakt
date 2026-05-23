/**
 * Condition.js
 * ------------
 * Condition objects determine whether a step fires on any given playthrough.
 * Ratio conditions: hits:of — fires on the Nth play out of every M loops.
 * Chance is handled separately on Step.chance (0–100%) and evaluated AFTER condition.
 *
 * Owns:    condition type registry, factory function
 * Depends: nothing
 * Used by: Step.js, Sequencer.js
 *
 * Public:
 *   Condition.create(type, options) — factory
 *   condition.evaluate(context)     — returns boolean
 *   condition.label                 — string for UI
 *   Condition.RATIO_LIST            — ordered list of { hits, of } for knob stepping
 *
 * Context: { playCount: number }
 */

// Build the ordered list of all ratio combos 1:1 → 8:8
// Order: 1:1, 1:2, 2:2, 1:3, 2:3, 3:3, 1:4 … 8:8
const _ratios = [];
for (let of_ = 1; of_ <= 8; of_++) {
  for (let hits = 1; hits <= of_; hits++) {
    _ratios.push({ hits, of: of_ });
  }
}

export const Condition = {

  /** All ratio steps in order, for knob use. Index 0 = "always" (no condition). */
  RATIO_LIST: _ratios,   // length 36

  create(type = 'always', options = {}) {
    switch (type) {

      case 'ratio': {
        const hits = options.hits ?? 1;
        const of_  = options.of   ?? 2;
        return {
          type, options: { hits, of: of_ },
          label: `${hits}:${of_}`,
          evaluate({ playCount }) {
            return (playCount % of_) === (hits - 1);
          }
        };
      }

      case 'always':
      default:
        return {
          type: 'always', options: {},
          label: '—',
          evaluate() { return true; }
        };
    }
  },

  toJSON(cond) {
    return { type: cond.type, options: { ...cond.options } };
  },

  fromJSON(obj) {
    return Condition.create(obj?.type ?? 'always', obj?.options ?? {});
  }
};
