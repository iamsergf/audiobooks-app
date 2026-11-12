// Оплата через Stripe Checkout (REST API, без SDK).
//
// Покупатель вводит данные карты на странице Stripe, а не у нас: номер карты
// никогда не проходит через этот сервер. Stripe принимает карты Visa / Mastercard /
// Amex и др., выпущенные банками разных стран, и сам проводит 3-D Secure.
//
// Если STRIPE_SECRET_KEY не задан, работает ДЕМО-режим: вместо Stripe открывается
// локальная страница-заглушка, деньги не списываются.
const crypto = require('crypto');

const STRIPE = 'https://api.stripe.com/v1';
const secret = () => process.env.STRIPE_SECRET_KEY || '';
const mode = () => (secret() ? (secret().startsWith('sk_live_') ? 'live' : 'test') : 'demo');

async function stripe(method, pathname, form) {
  const res = await fetch(STRIPE + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${secret()}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe: ${data.error?.message || res.status}`);
  return data;
}

// Демо-заказы живут в памяти процесса.
const demoOrders = new Map();

// -> { url } — адрес, на который нужно отправить покупателя
async function createCheckout({ book, uid, baseUrl }) {
  const item = `${book.provider}:${book.id}`;

  if (mode() === 'demo') {
    const token = crypto.randomBytes(16).toString('hex');
    demoOrders.set(token, { uid, item, title: book.title, price: book.price });
    return { url: `/demo-checkout.html?token=${token}` };
  }

  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'payment',
    success_url: `${baseUrl}/?paid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/?cancelled=1`,
    client_reference_id: uid,
    'metadata[uid]': uid,
    'metadata[item]': item,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': book.price.currency,
    'line_items[0][price_data][unit_amount]': String(book.price.amount),
    'line_items[0][price_data][product_data][name]': `${book.title} — ${book.author}`.slice(0, 250),
  });
  return { url: session.url };
}

// Проверяет на стороне сервера, что сессия действительно оплачена этим пользователем.
// -> ключ купленной книги ("provider:id") или null
async function confirmCheckout(sessionId, uid) {
  if (mode() === 'demo' || !/^cs_[\w]+$/.test(sessionId)) return null;
  const session = await stripe('GET', `/checkout/sessions/${sessionId}`);
  if (session.payment_status !== 'paid' || session.metadata?.uid !== uid) return null;
  return session.metadata.item || null;
}

function getDemoOrder(token, uid) {
  const order = demoOrders.get(token);
  return order && order.uid === uid ? order : null;
}

function completeDemoOrder(token, uid) {
  if (mode() !== 'demo') return null;
  const order = getDemoOrder(token, uid);
  if (!order) return null;
  demoOrders.delete(token);
  return order.item;
}

module.exports = { mode, createCheckout, confirmCheckout, getDemoOrder, completeDemoOrder };
