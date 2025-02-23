INSERT INTO user (user_id, email, first_name, last_name)
VALUES (?, ?, ?, ?)
ON CONFLICT(user_id) DO UPDATE SET
email = excluded.email,
first_name = excluded.first_name,
last_name = excluded.last_name,
updated_at = CURRENT_TIMESTAMP,
deleted_at = NULL