UPDATE user 
SET deleted_at = CURRENT_TIMESTAMP 
WHERE user_id = ? AND deleted_at IS NULL