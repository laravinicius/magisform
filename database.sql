-- MagisForm
-- Single source of truth for the server database schema.
-- Schema consolidado para o fluxo de pedidos.
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

CREATE TABLE IF NOT EXISTS insumos (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
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
CREATE INDEX idx_users_updated     ON users(updated_at);
CREATE INDEX idx_insumos_updated   ON insumos(updated_at);


CREATE UNIQUE INDEX uq_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_last_seen ON sessions(last_seen);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS action_logs (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NULL,
  user_name  VARCHAR(255) NOT NULL DEFAULT '',
  action     VARCHAR(50)  NOT NULL COMMENT 'login, logout, add, update, delete, update_status, update_delivery_status',
  entity     VARCHAR(50)  NOT NULL COMMENT 'users, insumos, orders, partner_pharmacies, system',
  entity_id  INT NULL,
  details    TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Farmácias solicitantes, usuários e pedidos.
CREATE TABLE IF NOT EXISTS partner_pharmacies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS partner_memberships (
  user_id INT NOT NULL PRIMARY KEY,
  pharmacy_id INT NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT fk_partner_member_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_partner_member_pharmacy FOREIGN KEY (pharmacy_id) REFERENCES partner_pharmacies(id) ON DELETE RESTRICT,
  KEY idx_partner_member_pharmacy (pharmacy_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS partner_patients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  pharmacy_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(30) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_partner_patient_pharmacy FOREIGN KEY (pharmacy_id) REFERENCES partner_pharmacies(id) ON DELETE RESTRICT,
  UNIQUE KEY uq_partner_patient (pharmacy_id, name, phone)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  pharmacy_id INT NOT NULL,
  status ENUM('submitted','under_review','awaiting_approval','accepted') NOT NULL DEFAULT 'submitted',
  original_data LONGTEXT NOT NULL CHECK (JSON_VALID(original_data)),
  current_data LONGTEXT NOT NULL CHECK (JSON_VALID(current_data)),
  proposed_data LONGTEXT NULL CHECK (proposed_data IS NULL OR JSON_VALID(proposed_data)),
  revision INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_pharmacy FOREIGN KEY (pharmacy_id) REFERENCES partner_pharmacies(id) ON DELETE RESTRICT,
  KEY idx_order_pharmacy_created (pharmacy_id, created_at, id),
  KEY idx_order_status_created (status, created_at, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  user_id INT NULL,
  actor_name VARCHAR(255) NOT NULL,
  action ENUM('submitted','imported','reviewed','accepted','proposed','approved','rejected') NOT NULL,
  snapshot LONGTEXT NULL CHECK (snapshot IS NULL OR JSON_VALID(snapshot)),
  note TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_event_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_event_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  KEY idx_order_event_order (order_id, id)
) ENGINE=InnoDB;

CREATE INDEX idx_action_logs_created ON action_logs(created_at);
CREATE INDEX idx_action_logs_user    ON action_logs(user_id);
CREATE INDEX idx_action_logs_action  ON action_logs(action);
CREATE INDEX idx_action_logs_entity  ON action_logs(entity);

-- Metadados de schema. A versão inicial é registrada exclusivamente pelo
-- comando explícito de bootstrap; upgrades registram checksums ao concluir.
CREATE TABLE IF NOT EXISTS schema_upgrade_progress (
  version INT NOT NULL PRIMARY KEY,
  checksum CHAR(64) NOT NULL,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

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
