import type { Card, CardValue, Customer, Order } from "./types";

const load = async <T>(name: string): Promise<T> => Bun.file(new URL(`../fixtures/${name}`, import.meta.url)).json();

export interface Fixtures {
  cards: Map<string, Card>;
  values: CardValue[];
  customers: Map<string, Customer>;
  orders: Order[];
  policy: string;
}

export async function loadFixtures(): Promise<Fixtures> {
  const [cards, values, customers, orders] = await Promise.all([
    load<Card[]>("cards.json"), load<CardValue[]>("values.json"),
    load<Customer[]>("customers.json"), load<Order[]>("orders.json"),
  ]);
  const policy = await Bun.file(new URL("../fixtures/policy.md", import.meta.url)).text();
  return {
    cards: new Map(cards.map((c) => [c.id, c])),
    values,
    customers: new Map(customers.map((c) => [c.email.toLowerCase(), c])),
    orders,
    policy,
  };
}
