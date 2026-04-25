-- ===========================
--   Anime Card Game Schema
-- ===========================

CREATE DATABASE IF NOT EXISTS `card` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `card`;

CREATE TABLE IF NOT EXISTS `players` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `telegram_id`      BIGINT NOT NULL UNIQUE,
  `real_name`        VARCHAR(100) NOT NULL,
  `character_name`   VARCHAR(100) NOT NULL,
  `player_code`      VARCHAR(20)  NOT NULL UNIQUE,
  `is_admin`         BOOLEAN DEFAULT FALSE,
  `can_manage_cards` BOOLEAN DEFAULT FALSE,
  `wins`             INT DEFAULT 0,
  `losses`           INT DEFAULT 0,
  `created_at`       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `player_bot_progress` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `player_id`      INT NOT NULL UNIQUE,
  `unlocked_level` INT NOT NULL DEFAULT 1,
  `created_at`     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `identity_cards` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `card_id`          VARCHAR(20) NOT NULL UNIQUE,
  `player_id`        INT NOT NULL,
  `name`             VARCHAR(100) NOT NULL,
  `image_id`         VARCHAR(255) DEFAULT NULL,
  `hp`               INT DEFAULT 0,
  `atk`              INT DEFAULT 0,
  `available_atk`    INT DEFAULT 0,
  `magic`            INT DEFAULT 0,   -- magic cap (stored separately, not from pool)
  `available_magic`  INT DEFAULT 0,
  `def`              INT DEFAULT 0,
  `available_def`    INT DEFAULT 0,
  `spd`              INT DEFAULT 0,
  `available_spd`    INT DEFAULT 0,
  `accuracy`         INT DEFAULT 0,
  `available_accuracy` INT DEFAULT 0,
  `total_points`     INT DEFAULT 10000,
  `remaining_points` INT DEFAULT 10000,
  `created_at`       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `play_cards` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `card_id`          VARCHAR(20) NOT NULL UNIQUE,
  `player_id`        INT NOT NULL,
  `identity_card_id` INT NOT NULL,
  `name`             VARCHAR(100) NOT NULL,
  `image_id`         VARCHAR(255) DEFAULT NULL,
  `type`             ENUM('attack','defense','magic') NOT NULL,
  `atk`              INT DEFAULT 0,
  `magic`            INT DEFAULT 0,
  `def`              INT DEFAULT 0,
  `accuracy`         INT DEFAULT 0,
  `spd`              INT DEFAULT 0,
  `created_at`       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`identity_card_id`) REFERENCES `identity_cards`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `skill_cards` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `card_id`        VARCHAR(20) NOT NULL UNIQUE,
  `player_id`      INT NOT NULL,
  `name`           VARCHAR(100) NOT NULL,
  `image_id`       VARCHAR(255) DEFAULT NULL,
  `type`           ENUM('reflect','negate','stun','almighty','poison') NOT NULL,
  `effect_points`  INT DEFAULT 0,
  `poison_percent` FLOAT DEFAULT 0,
  `duration`       ENUM('1','2','all') NOT NULL DEFAULT '1',
  `created_at`     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `weapon_cards` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `card_id`      VARCHAR(20) NOT NULL UNIQUE,
  `player_id`    INT NOT NULL,
  `name`         VARCHAR(100) NOT NULL,
  `image_id`     VARCHAR(255) DEFAULT NULL,
  `weapon_type`  ENUM('enhanced','normal') NOT NULL,
  `sub_type`     ENUM('attack','defense','magic') DEFAULT NULL,
  `boost_percent` FLOAT DEFAULT 0,
  `boost_target` ENUM('atk','magic','def','spd','accuracy','effect','all') DEFAULT NULL,
  `atk`          INT DEFAULT 0,
  `magic`        INT DEFAULT 0,
  `def`          INT DEFAULT 0,
  `accuracy`     INT DEFAULT 0,
  `spd`          INT DEFAULT 0,
  `total_points` INT DEFAULT 10000,
  `duration`     ENUM('1','2','all') DEFAULT NULL,
  `created_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bot card sets (one identity card per level)
CREATE TABLE IF NOT EXISTS `bot_card_sets` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `level`            INT NOT NULL UNIQUE,
  `identity_card_id` VARCHAR(20) NOT NULL,
  `created_at`       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `bot_play_cards` (
  `id`      INT AUTO_INCREMENT PRIMARY KEY,
  `level`   INT NOT NULL,
  `card_id` VARCHAR(20) NOT NULL,
  UNIQUE KEY `uq_bot_play` (`level`, `card_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `bot_skill_cards` (
  `id`      INT AUTO_INCREMENT PRIMARY KEY,
  `level`   INT NOT NULL,
  `card_id` VARCHAR(20) NOT NULL,
  UNIQUE KEY `uq_bot_skill` (`level`, `card_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `bot_weapon_cards` (
  `id`      INT AUTO_INCREMENT PRIMARY KEY,
  `level`   INT NOT NULL,
  `card_id` VARCHAR(20) NOT NULL,
  UNIQUE KEY `uq_bot_weapon` (`level`, `card_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
