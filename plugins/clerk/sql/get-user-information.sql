SELECT email, first_name, last_name FROM user 
WHERE user_id = ? AND deleted_at IS NULL