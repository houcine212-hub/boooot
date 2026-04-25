USE `card`;

SET @db_name = DATABASE();

SET @sql = IF(
  EXISTS(
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name
      AND TABLE_NAME = 'identity_cards'
      AND COLUMN_NAME = 'image_id'
  ),
  'SELECT 1',
  'ALTER TABLE `identity_cards` ADD COLUMN `image_id` VARCHAR(255) NULL'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name
      AND TABLE_NAME = 'play_cards'
      AND COLUMN_NAME = 'image_id'
  ),
  'SELECT 1',
  'ALTER TABLE `play_cards` ADD COLUMN `image_id` VARCHAR(255) NULL'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name
      AND TABLE_NAME = 'skill_cards'
      AND COLUMN_NAME = 'image_id'
  ),
  'SELECT 1',
  'ALTER TABLE `skill_cards` ADD COLUMN `image_id` VARCHAR(255) NULL'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @db_name
      AND TABLE_NAME = 'weapon_cards'
      AND COLUMN_NAME = 'image_id'
  ),
  'SELECT 1',
  'ALTER TABLE `weapon_cards` ADD COLUMN `image_id` VARCHAR(255) NULL'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
