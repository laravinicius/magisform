-- Remove o modelo anterior, preservando usuários, farmácias e pedidos atuais.
ALTER TABLE orders DROP FOREIGN KEY IF EXISTS fk_order_legacy_formula;
ALTER TABLE orders DROP INDEX IF EXISTS uq_order_legacy_formula;
ALTER TABLE orders DROP COLUMN IF EXISTS legacy_formula_id;

DROP TABLE IF EXISTS formula_budget_items;
DROP TABLE IF EXISTS formula_items;
DROP TABLE IF EXISTS saved_formula_budget_items;
DROP TABLE IF EXISTS saved_formula_items;
DROP TABLE IF EXISTS budget_number_registry;
DROP TABLE IF EXISTS saved_formulas;
DROP TABLE IF EXISTS formulas;
DROP TABLE IF EXISTS customers;

DELETE FROM insumos;
DELETE FROM action_logs WHERE entity IN ('customers','formulas','saved_formulas','insumos');
