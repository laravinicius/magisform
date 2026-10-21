-- Upgrade 003: unidades e autoria historica. Executado somente pelo comando explicito.
ALTER TABLE formulas ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(255) NULL COMMENT 'Nome do funcionário no momento da criação';
ALTER TABLE saved_formulas ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(255) NULL COMMENT 'Nome do funcionário no momento da criação';
ALTER TABLE formula_budget_items MODIFY COLUMN unit VARCHAR(16) NOT NULL DEFAULT 'caps' COMMENT 'caps, caps s.l., doses, g, ml, sachê, %';
ALTER TABLE saved_formula_budget_items MODIFY COLUMN unit VARCHAR(16) NOT NULL DEFAULT 'caps' COMMENT 'caps, caps s.l., doses, g, ml, sachê, %';
ALTER TABLE formula_items MODIFY COLUMN unit VARCHAR(5) NOT NULL DEFAULT 'mg' COMMENT 'g, mcg, ui, mg, ml, %';
ALTER TABLE saved_formula_items MODIFY COLUMN unit VARCHAR(5) NOT NULL DEFAULT 'mg' COMMENT 'g, mcg, ui, mg, ml, %';

UPDATE formulas AS f
JOIN (
  SELECT entity_id, MAX(user_name) AS creator_name
  FROM action_logs
  WHERE action = 'add' AND entity = 'formulas'
  GROUP BY entity_id
  HAVING COUNT(*) = 1
     AND NULLIF(TRIM(MAX(user_name)), '') IS NOT NULL
     AND TRIM(MAX(user_name)) <> 'Configuração'
) AS creation ON creation.entity_id = f.id
SET f.created_by_name = creation.creator_name, f.updated_at = f.updated_at
WHERE NULLIF(TRIM(f.created_by_name), '') IS NULL;

UPDATE saved_formulas AS f
JOIN (
  SELECT entity_id, MAX(user_name) AS creator_name
  FROM action_logs
  WHERE action = 'add' AND entity = 'saved_formulas'
  GROUP BY entity_id
  HAVING COUNT(*) = 1
     AND NULLIF(TRIM(MAX(user_name)), '') IS NOT NULL
     AND TRIM(MAX(user_name)) <> 'Configuração'
) AS creation ON creation.entity_id = f.id
SET f.created_by_name = creation.creator_name, f.updated_at = f.updated_at
WHERE NULLIF(TRIM(f.created_by_name), '') IS NULL;

