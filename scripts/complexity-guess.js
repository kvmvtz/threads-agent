// Very rough "at a glance" dev-complexity guess by business category.
// Not a quote — just enough to help Nikita triage which leads to chase first.
const RULES = [
  { match: /real estate|coworking/i, level: 'Высокая' }, // listings, search/filter, maps
  { match: /auto repair|clean(ing)?|electric|plumb/i, level: 'Низкая' }, // one-pager + contact form
  { match: /dentist|yoga|pet groom|photographer|florist|tattoo|hair salon|bakery|boutique/i, level: 'Средняя' }, // booking/gallery/shop-ish
];

function guessComplexity(category) {
  for (const rule of RULES) {
    if (rule.match.test(category)) return rule.level;
  }
  return 'Средняя';
}

module.exports = { guessComplexity };
