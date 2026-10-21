-- MagisForm
-- Single source of truth for the server database schema.
-- Reconstructed from migrations 0001-0020 (migration_final.sql) — reflects
-- the actual final state of the schema, not a hand-maintained snapshot.
--
-- No seeding de credenciais administrativas. O administrador inicial é
-- criado pelo fluxo explícito de provisionamento.

CREATE DATABASE IF NOT EXISTS magisform
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE magisform;

CREATE TABLE IF NOT EXISTS users (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  username   VARCHAR(50)  NOT NULL UNIQUE,
  password   VARCHAR(255) NOT NULL COMMENT 'Formato legado SHA-256 ou hash codificado',
  role       ENUM('admin','manager','pharmacist','employee') NOT NULL DEFAULT 'employee',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS customers (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  phone      VARCHAR(20)  NULL,
  responsible_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_customers_phone (phone),
  KEY idx_customers_responsible (responsible_id),
  CONSTRAINT fk_customers_responsible FOREIGN KEY (responsible_id) REFERENCES customers(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS insumos (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS formulas (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  customer_id     INT NOT NULL,
  customer_phone  VARCHAR(20)  NOT NULL DEFAULT '',
  attendant_name  VARCHAR(255) NOT NULL DEFAULT '',
  created_by_name VARCHAR(255) NULL COMMENT 'Nome do funcionário no momento da criação',
  budget_number   VARCHAR(6)   NOT NULL DEFAULT '',
  delivery_date   DATE         NULL,
  delivered_at    DATETIME     NULL COMMENT 'Entrega efetiva no fuso America/Sao_Paulo, registrada pelo backend',
  payment_status  VARCHAR(20)  NOT NULL DEFAULT '',
  partial_payment_amount DECIMAL(10,2) NULL COMMENT 'quantia paga quando payment_status=parcial',
  payment_method  VARCHAR(20)  NULL,
  delivery_status VARCHAR(20)  NOT NULL DEFAULT '' COMMENT 'Andamento: em_producao (padrão ao confirmar), aguardando_retirada, entregue',
  manager_verified TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Verificação visual do Histórico pelo Gerente',
  cancel_reason   TEXT         NULL,
  status          ENUM('pending','confirmed','cancelled','delivered') NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS formula_items (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  formula_id  INT           NOT NULL,
  insumo_id   INT           NOT NULL,
  quantity    DECIMAL(10,3) NOT NULL COMMENT 'quantidade',
  unit        VARCHAR(5)    NOT NULL DEFAULT 'mg' COMMENT 'g, mcg, ui, mg, ml, %',
  FOREIGN KEY (formula_id) REFERENCES formulas(id) ON DELETE CASCADE,
  FOREIGN KEY (insumo_id)  REFERENCES insumos(id)  ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS formula_budget_items (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  formula_id  INT            NOT NULL,
  quantity    DECIMAL(10,3)  NOT NULL COMMENT 'quantidade',
  unit        VARCHAR(16)    NOT NULL DEFAULT 'caps' COMMENT 'caps, caps s.l., doses, g, ml, sachê, %',
  value       DECIMAL(10,2)  NOT NULL DEFAULT 0 COMMENT 'valor em R$',
  is_selected TINYINT(1)     NOT NULL DEFAULT 0 COMMENT 'orçamento escolhido',
  FOREIGN KEY (formula_id) REFERENCES formulas(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS saved_formulas (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(255) NOT NULL UNIQUE,
  created_by_name VARCHAR(255) NULL COMMENT 'Nome do funcionário no momento da criação',
  budget_number VARCHAR(6)   NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS budget_number_registry (
  budget_number VARCHAR(6)  NOT NULL PRIMARY KEY,
  source_type   ENUM('formula','saved_formula') NOT NULL,
  source_id     INT          NOT NULL,
  created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_budget_number_source (source_type, source_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS saved_formula_items (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  saved_formula_id INT           NOT NULL,
  insumo_id        INT           NOT NULL,
  quantity         DECIMAL(10,3) NOT NULL COMMENT 'quantidade',
  unit             VARCHAR(5)    NOT NULL DEFAULT 'mg' COMMENT 'g, mcg, ui, mg, ml, %',
  FOREIGN KEY (saved_formula_id) REFERENCES saved_formulas(id) ON DELETE CASCADE,
  FOREIGN KEY (insumo_id)        REFERENCES insumos(id)        ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS saved_formula_budget_items (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  saved_formula_id INT            NOT NULL,
  quantity         DECIMAL(10,3)  NOT NULL COMMENT 'quantidade',
  unit             VARCHAR(16)    NOT NULL DEFAULT 'caps' COMMENT 'caps, caps s.l., doses, g, ml, sachê, %',
  value            DECIMAL(10,2)  NOT NULL DEFAULT 0 COMMENT 'valor em R$',
  FOREIGN KEY (saved_formula_id) REFERENCES saved_formulas(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sessions (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT          NOT NULL,
  token      VARCHAR(64)  NOT NULL UNIQUE,
  policy     ENUM('desktop_local','hosted') NOT NULL DEFAULT 'desktop_local',
  last_seen  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NULL,
  absolute_expires_at DATETIME NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Indexes
CREATE INDEX idx_formulas_created_id ON formulas(created_at, id);
CREATE INDEX idx_users_updated     ON users(updated_at);
CREATE INDEX idx_customers_updated ON customers(updated_at);
CREATE INDEX idx_insumos_updated   ON insumos(updated_at);
CREATE INDEX idx_formulas_updated  ON formulas(updated_at);
CREATE INDEX idx_saved_formulas_updated ON saved_formulas(updated_at);

CREATE INDEX idx_formula_items_formula_id ON formula_items(formula_id);
CREATE INDEX idx_formula_items_insumo_id  ON formula_items(insumo_id);
CREATE INDEX idx_formula_budget_items_formula_id ON formula_budget_items(formula_id);
CREATE INDEX idx_saved_formula_items_saved_formula_id ON saved_formula_items(saved_formula_id);
CREATE INDEX idx_saved_formula_items_insumo_id ON saved_formula_items(insumo_id);
CREATE INDEX idx_saved_formula_budget_items_saved_formula_id ON saved_formula_budget_items(saved_formula_id);

CREATE UNIQUE INDEX uq_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_last_seen ON sessions(last_seen);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS action_logs (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NULL,
  user_name  VARCHAR(255) NOT NULL DEFAULT '',
  action     VARCHAR(50)  NOT NULL COMMENT 'login, logout, add, update, delete, update_status, update_delivery_status',
  entity     VARCHAR(50)  NOT NULL COMMENT 'users, customers, insumos, formulas, saved_formulas, system',
  entity_id  INT NULL,
  details    TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE INDEX idx_action_logs_created ON action_logs(created_at);
CREATE INDEX idx_action_logs_user    ON action_logs(user_id);
CREATE INDEX idx_action_logs_action  ON action_logs(action);
CREATE INDEX idx_action_logs_entity  ON action_logs(entity);

-- Metadados de schema. A versão inicial é registrada exclusivamente pelo
-- comando explícito de bootstrap; upgrades registram checksums ao concluir.
CREATE TABLE IF NOT EXISTS schema_version (
  singleton  TINYINT NOT NULL PRIMARY KEY,
  version    INT NOT NULL,
  source     ENUM('bootstrap','upgrade') NOT NULL,
  checksum   CHAR(64) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_schema_version_singleton CHECK (singleton = 1)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS schema_upgrade_history (
  version      INT NOT NULL PRIMARY KEY,
  checksum     CHAR(64) NOT NULL,
  completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
