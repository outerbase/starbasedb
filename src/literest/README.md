# GET

Fetch data from the database.

## Equals

Get any entry that matches the column named `name` inside the `users` table where name = `Alice`.

```
curl --location --request GET 'https://starbasedb.{YOUR-IDENTIFIER}.workers.dev/rest/users?name=Alice' \
--header 'Authorization: Bearer ABC123' \
--header 'Content-Type: application/x-www-form-urlencoded' \
--data-urlencode 'Content-type=application/json'
```

## Not Equals

Get any result that does NOT equal the provided value.

```
curl --location --request GET 'https://starbasedb.{YOUR-IDENTIFIER}.workers.dev/rest/users?name.ne=Alice' \
--header 'Authorization: Bearer ABC123' \
--header 'Content-Type: application/x-www-form-urlencoded' \
--data-urlencode 'Content-type=application/json'
```

## LIKE

The URL has `%25` appended to it which represents the `%` character. We need the `%` character to represent in SQL any number of characters can appear here to be considered "LIKE".

```
curl --location --request GET 'https://starbasedb.{YOUR-IDENTIFIER}.workers.dev/rest/users?name.like=Al%25' \
--header 'Authorization: Bearer ABC123' \
--header 'Content-Type: application/x-www-form-urlencoded' \
--data-urlencode 'Content-type=application/json'
```

## IN

Get all results that match the names in the IN criteria, which the example below includes `Alice` and `Bob`.

```
curl --location --request GET 'https://starbasedb.{YOUR-IDENTIFIER}.workers.dev/rest/users?name.in=Alice,Bob' \
--header 'Authorization: Bearer ABC123' \
--header 'Content-Type: application/x-www-form-urlencoded' \
--data-urlencode 'Content-type=application/json'
```

## Greater Than

```
curl --location --request GET 'https://starbasedb.{YOUR-IDENTIFIER}.workers.dev/rest/users?user_id.gt=0' \
--header 'Authorization: Bearer ABC123' \
--header 'Content-Type: application/x-www-form-urlencoded' \
--data-urlencode 'Content-type=application/json'
```

## Greater Than or Equal

```
curl --location --request GET 'https://starbasedb.{YOUR-IDENTIFIER}.workers.dev/rest/users?user_id.gte=1' \
--header 'Authorization: Bearer ABC123' \
--header 'Content-Type: application/x-www-form-urlencoded' \
--data-urlencode 'Content-type=application/json'
```

## Less Than

```
curl --location --request GET 'https://starbasedb.{YOUR-IDENTIFIER}.workers.dev/rest/users?user_id.lt=3' \
--header 'Authorization: Bearer ABC123' \
--header 'Content-Type: application/x-www-form-urlencoded' \
--data-urlencode 'Content-type=application/json'
```

## Less Than or Equal

```
curl --location --request GET 'https://starbasedb.{YOUR-IDENTIFIER}.workers.dev/rest/users?user_id.lte=3' \
--header 'Authorization: Bearer ABC123' \
--header 'Content-Type: application/x-www-form-urlencoded' \
--data-urlencode 'Content-type=application/json'
```

## SORT BY & ORDER

```
curl --location --request GET 'https://starbasedb.{YOUR-IDENTIFIER}.workers.dev/rest/users?sort_by=user_id&order=DESC' \
--header 'Authorization: Bearer ABC123' \
--header 'Content-Type: application/x-www-form-urlencoded' \
--data-urlencode 'Content-type=application/json'
```

## LIMIT & OFFSET

```
curl --location --request GET 'https://starbasedb.{YOUR-IDENTIFIER}.workers.dev/rest/users?limit=2&offset=1' \
--header 'Authorization: Bearer ABC123' \
--header 'Content-Type: application/x-www-form-urlencoded' \
--data-urlencode 'Content-type=application/json'
```

## A bit of everything

```
curl --location --request GET 'https://starbasedb.{YOUR-IDENTIFIER}.workers.dev/rest/users?name.in=Alice%2CBob&user_id.gte=0&email.like=%25example.com&sort_by=user_id&order=DESC&limit=10&offset=0' \
--header 'Authorization: Bearer ABC123' \
--header 'Content-Type: application/x-www-form-urlencoded' \
--data-urlencode 'Content-type=application/json'
```

# POST

```
curl --location 'https://starbasedb.{YOUR-IDENTIFIER}.workers.dev/rest/users' \
--header 'Authorization: Bearer ABC123' \
--header 'Content-Type: text/plain' \
--header 'Content-type: application/json' \
--data-raw '{
  "name": "Brayden",
  "email": "brayden@outerbase.com"
}'
```

# DELETE

```
curl --location --request DELETE 'https://starbasedb.{YOUR-IDENTIFIER}.workers.dev/rest/users/4' \
--header 'Authorization: Bearer ABC123'
```

# PUT

A PUT command is to do a FULL replacement of the entry in the table. For partial updates see PATCH

```
curl --location --request PUT 'https://starbasedb.{YOUR-IDENTIFIER}.workers.dev/rest/users/4' \
--header 'Authorization: Bearer ABC123' \
--header 'Content-Type: text/plain' \
--header 'Content-type: application/json' \
--data-raw '{
    "name": "Brandon",
    "email": "brandon@outerbase.com"
}'
```

# PATCH

A PATCH command is to do a PARTIAL replacement of the entry in the table. For full updates see PUT

```
curl --location --request PATCH 'https://starbasedb.{YOUR-IDENTIFIER}.workers.dev/rest/users/4' \
--header 'Authorization: Bearer ABC123' \
--header 'Content-Type: text/plain' \
--header 'Content-type: application/json' \
--data-raw '{
    "email": "brayden+1@outerbase.com"
}'
```
