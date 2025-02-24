INSERT INTO user_session (session_id, user_id)
VALUES (?, ?)
ON CONFLICT(session_id) DO UPDATE SET
updated_at = CURRENT_TIMESTAMP