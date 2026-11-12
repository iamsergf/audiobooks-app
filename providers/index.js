// Реестр провайдеров. Чтобы добавить нового — напишите адаптер по образцу
// _template.js и добавьте его в этот список.
const all = [require('./librivox'), require('./archive'), require('./litres'), require('./demostore')];

const active = () => all.filter((p) => !p.enabled || p.enabled());

module.exports = {
  list: active,
  get: (id) => active().find((p) => p.id === id) || null,
};
