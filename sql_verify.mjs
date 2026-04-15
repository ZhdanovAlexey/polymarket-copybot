import { initDb, closeDb, getDb } from './src/db/database.js';

initDb(':memory:');

const db = getDb();
db.exec(`
  INSERT INTO bt_trader_activity (id, address, timestamp, token_id, condition_id, action, price, size, usd_value, market_slug)
  VALUES ('t1', '0xA', 100, 'tok1', 'c1', 'buy', 0.5, 10, 5, 's');
  INSERT INTO bt_trader_activity (id, address, timestamp, token_id, condition_id, action, price, size, usd_value, market_slug)
  VALUES ('t2', '0xA', 100, 'tok2', 'c2', 'buy', 0.5, 10, 5, 's');
  INSERT INTO bt_markets (condition_id, question, slug, end_date, volume, liquidity, neg_risk, closed, token_ids)
  VALUES ('c1', 'q1', 's1', null, 0, 0, 0, 0, '[]');
`);

console.log('Testing LEFT JOIN logic:');
const plan = db.prepare(`EXPLAIN QUERY PLAN
  SELECT DISTINCT a.condition_id
  FROM bt_trader_activity a
  LEFT JOIN bt_markets m ON m.condition_id = a.condition_id
  WHERE m.condition_id IS NULL
`).all();
console.log('Query plan:', plan);

const results = db.prepare(`
  SELECT DISTINCT a.condition_id
  FROM bt_trader_activity a
  LEFT JOIN bt_markets m ON m.condition_id = a.condition_id
  WHERE m.condition_id IS NULL
`).all();
console.log('Missing condition IDs (c2 should be present, c1 should not):', results);

closeDb();
