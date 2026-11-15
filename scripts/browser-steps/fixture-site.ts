import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FIXTURE_ACCOUNT = { username: "test.buyer", password: "fixture-only-4417" } as const;
export const FIXTURE_ANSWERS = {
  find: { price: "$34.50", threshold: "$60" },
  form: { reference: "CF-4821" },
  table: { order: "1042", total: "$218.40", status: "Shipped" },
} as const;

const NAV = ["Home", "Shop", "Deals", "New arrivals", "Kitchen", "Garden", "Lighting", "Bath", "Gifts", "Brands", "Stores", "Help", "Contact", "Orders"];
const PRODUCTS = [
  "Oak Cutting Board", "Steel Ladle", "Ceramic Mug", "Glass Teapot", "Linen Napkins", "Copper Pan", "Bamboo Tray", "Herb Planter",
  "Wool Throw", "Desk Lamp", "Bath Mat", "Soap Dish", "Salad Bowl", "Pepper Mill", "Bread Knife", "Wine Rack",
  "Spice Jar Set", "Tea Towels", "Candle Trio", "Fruit Basket", "Water Carafe", "Cast Iron Skillet", "Measuring Cups", "Blue Kettle",
  "Utensil Crock", "Butter Dish", "Cheese Board", "Garden Gloves", "Watering Can", "Picture Frame",
];

const price = (index: number) => (index === 23 ? "$34.50" : `$${(9 + ((index * 7.35) % 80)).toFixed(2)}`);

function page(title: string, body: string): string {
  const nav = NAV.map((name) => `<a href="/${name === "Home" ? "" : name.toLowerCase().replace(/ /g, "-")}">${name}</a>`).join(" ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} · Hearth Goods</title>
<style>body{font:16px/1.5 sans-serif;margin:0}header,footer{background:#f3f1ec;padding:12px 24px}header a{margin-right:12px}
main{padding:16px 24px;max-width:960px}li{padding:6px 0;border-bottom:1px solid #eee}label{display:block;margin-top:10px}
input,select,textarea{font:inherit;padding:6px;width:320px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px}</style></head>
<body><header><strong>Hearth Goods</strong><nav>${nav}</nav></header><main><h1>${title}</h1>${body}</main>
<footer><p>Hearth Goods, 12 Market Lane. <a href="/shipping">Shipping policy</a> · <a href="/returns">Returns</a> · <a href="/privacy">Privacy</a> · <a href="/careers">Careers</a></p></footer></body></html>`;
}

const intro = "<p>Everything for a warm home, picked by people who cook, garden and host. Prices include tax. Stock changes daily, so check the item page before you visit a store.</p>";

function shop(): string {
  const items = PRODUCTS.map((name, index) => `<li><strong>${name}</strong> · ${price(index)} · <button type="button">Add to basket</button></li>`).join("");
  return page("Shop", `${intro}<ul>${items}</ul>`);
}

function shipping(): string {
  return page("Shipping policy", "<p>We ship to every state within five working days.</p><p>Shipping is free on orders over $60. Below that it costs $6.95.</p><p>Large furniture ships separately and may take longer.</p>");
}

function contact(): string {
  const topics = ["Choose a topic", "Billing", "Delivery", "Returns", "Product question", "Something else"]
    .map((topic, index) => `<option value="${index === 0 ? "" : topic.toLowerCase()}">${topic}</option>`).join("");
  return page("Contact us", `<p>We answer within one working day.</p><form method="post" action="/contact">
<label for="name">Full name</label><input id="name" name="name" required>
<label for="email">Email</label><input id="email" name="email" type="email" required>
<label for="phone">Phone</label><input id="phone" name="phone" type="tel" required>
<label for="topic">Topic</label><select id="topic" name="topic" required>${topics}</select>
<label for="message">Message</label><textarea id="message" name="message" rows="4" required></textarea>
<p><button type="submit">Send message</button></p></form>`);
}

function thanks(fields: URLSearchParams): string {
  const complete = ["name", "email", "phone", "topic", "message"].every((key) => (fields.get(key) ?? "").trim());
  return complete
    ? page("Message sent", `<p>Thank you, ${escape(fields.get("name") ?? "")}. Your reference is <strong>${FIXTURE_ANSWERS.form.reference}</strong>.</p>`)
    : page("Something is missing", "<p>Please fill in every field.</p>");
}

function login(failed: boolean): string {
  return page("Sign in", `${failed ? "<p role=\"alert\">That username or password is wrong.</p>" : ""}<p>Sign in to see your orders.</p>
<form method="post" action="/login"><label for="username">Username</label><input id="username" name="username" autocomplete="username">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
<p><button type="submit">Sign in</button></p></form>`);
}

function orders(): string {
  const rows = Array.from({ length: 12 }, (_, index) => {
    const number = 1035 + index;
    const total = number === 1042 ? "$218.40" : `$${(40 + index * 13.7).toFixed(2)}`;
    const status = number === 1042 ? "Shipped" : ["Delivered", "Processing", "Delivered", "Cancelled"][index % 4];
    return `<tr><td>#${number}</td><td>2026-10-${String(1 + index * 2).padStart(2, "0")}</td><td>${1 + (index % 5)} items</td><td>${total}</td><td>${status}</td></tr>`;
  }).join("");
  return page("Your orders", `<table><thead><tr><th>Order</th><th>Date</th><th>Items</th><th>Total</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function escape(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]!);
}

async function body(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function send(response: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(html);
}

export async function handleFixture(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://fixture.local");
  const signedIn = /(?:^|;\s*)session=ok(?:;|$)/.test(request.headers.cookie ?? "");
  if (request.method === "POST" && url.pathname === "/contact") return send(response, 200, thanks(await body(request)));
  if (request.method === "POST" && url.pathname === "/login") {
    const fields = await body(request);
    if (fields.get("username") === FIXTURE_ACCOUNT.username && fields.get("password") === FIXTURE_ACCOUNT.password) {
      return send(response, 303, "", { location: "/orders", "set-cookie": "session=ok; Path=/; HttpOnly; SameSite=Lax" });
    }
    return send(response, 200, login(true));
  }
  switch (url.pathname) {
    case "/": return send(response, 200, page("Welcome", intro));
    case "/shop": return send(response, 200, shop());
    case "/shipping": return send(response, 200, shipping());
    case "/contact": return send(response, 200, contact());
    case "/login": return send(response, 200, login(false));
    case "/orders": return signedIn ? send(response, 200, orders()) : send(response, 303, "", { location: "/login" });
    default: return send(response, 200, page("Coming soon", "<p>This page is not part of the fixture.</p>"));
  }
}

export async function startFixtureSite(port = 0): Promise<{ origin: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => { void handleFixture(request, response).catch(() => send(response, 500, "error")); });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${bound}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
