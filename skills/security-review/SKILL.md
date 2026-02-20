---
name: security-review
description: Cross-language security checklist for C#/.NET, TypeScript, Rust, and Python. Covers secrets management, injection prevention, authentication, input validation, and secure defaults.
---

# Security Review

Security patterns and checklist across all languages.

## When to Activate

- Implementing authentication or authorization
- Handling user input or file uploads
- Creating new API endpoints
- Working with secrets or credentials
- Integrating external APIs
- Storing or transmitting sensitive data
- Reviewing code before deployment

## 1. Secrets Management

**Rule**: No secrets in source code. Ever.

```
# BAD — anywhere in code
api_key = "sk-proj-xxxxx"
connection_string = "Server=prod;Password=secret123"

# GOOD — environment / secret manager
api_key = Environment.GetEnvironmentVariable("API_KEY")
```

**Checklist:**
- [ ] No hardcoded credentials, API keys, tokens, or connection strings
- [ ] Secrets loaded from environment variables or a secret manager (Azure Key Vault, AWS Secrets Manager)
- [ ] `.env` files in `.gitignore`
- [ ] No secrets in log output
- [ ] Separate secrets per environment (dev/staging/prod)

## 2. Input Validation

**Rule**: Validate all external input at system boundaries.

### C# / .NET
```csharp
// FluentValidation or data annotations for DTOs
public class CreateOrderRequestValidator : AbstractValidator<CreateOrderRequest>
{
    public CreateOrderRequestValidator()
    {
        RuleFor(x => x.CustomerId).GreaterThan(0);
        RuleFor(x => x.Items).NotEmpty();
        RuleForEach(x => x.Items).ChildRules(item =>
        {
            item.RuleFor(i => i.Quantity).GreaterThan(0);
        });
    }
}
```

### TypeScript
```typescript
// Zod at API boundaries
const createOrderSchema = z.object({
  customerId: z.string().uuid(),
  items: z.array(orderItemSchema).min(1),
});
```

### Python
```python
# Pydantic models
class CreateOrderRequest(BaseModel):
    customer_id: int = Field(gt=0)
    items: list[OrderItem] = Field(min_length=1)
```

**Checklist:**
- [ ] All API endpoint inputs validated with a schema/validator
- [ ] File uploads validated: type, size, content (not just extension)
- [ ] Path parameters sanitized — no path traversal (`../`)
- [ ] Query parameters bounded — pagination limits enforced

## 3. SQL Injection Prevention

**Rule**: Never concatenate or interpolate user input into SQL.

### C# / EF Core
```csharp
// BAD — SQL injection
var sql = $"SELECT * FROM Users WHERE Name = '{name}'";
db.Users.FromSqlRaw(sql);

// GOOD — parameterized (EF Core 10)
db.Users.FromSql($"SELECT * FROM Users WHERE Name = {name}");

// GOOD — LINQ (always safe)
db.Users.Where(u => u.Name == name);
```

### Rust / SQLx
```rust
// BAD
let sql = format!("SELECT * FROM users WHERE name = '{name}'");

// GOOD — parameterized
sqlx::query_as!(User, "SELECT * FROM users WHERE name = $1", name)
    .fetch_one(pool).await?;
```

### Python / SQLAlchemy
```python
# BAD
db.execute(f"SELECT * FROM users WHERE name = '{name}'")

# GOOD
db.execute(text("SELECT * FROM users WHERE name = :name"), {"name": name})
```

## 4. Authentication & Authorization

**Checklist:**
- [ ] Every endpoint has explicit auth: `[Authorize]`, `.RequireAuthorization()`, or `[AllowAnonymous]`
- [ ] JWT tokens validated: signature, expiration, issuer, audience
- [ ] Cookies: `HttpOnly`, `Secure`, `SameSite=Strict`
- [ ] Password hashing: bcrypt, Argon2, or PBKDF2 — never MD5/SHA-1
- [ ] Rate limiting on auth endpoints (login, register, password reset)
- [ ] Account lockout after failed attempts

## 5. XSS Prevention

**Rule**: Never render unsanitized user input as HTML.

```typescript
// BAD — React dangerouslySetInnerHTML without sanitization
<div dangerouslySetInnerHTML={{ __html: userContent }} />

// GOOD — sanitize first
import DOMPurify from "dompurify";
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(userContent) }} />

// BEST — use text content (no HTML)
<div>{userContent}</div>
```

**Checklist:**
- [ ] CSP headers configured
- [ ] User content rendered as text, not HTML
- [ ] If HTML needed, sanitized with DOMPurify or equivalent
- [ ] API responses set `Content-Type` correctly

## 6. CSRF Protection

**Checklist:**
- [ ] `SameSite=Strict` on cookies
- [ ] Anti-forgery tokens for form submissions (.NET: `[ValidateAntiForgeryToken]`)
- [ ] State-changing operations use POST/PUT/DELETE, never GET

## 7. Rate Limiting

**Checklist:**
- [ ] Public endpoints rate-limited
- [ ] Auth endpoints more aggressively limited
- [ ] Rate limits return `429 Too Many Requests`
- [ ] Rate limiting at API gateway or middleware level

## 8. Sensitive Data Exposure

**Checklist:**
- [ ] Error responses don't leak internals (stack traces, SQL, file paths)
- [ ] Logs don't contain PII (emails, passwords, tokens, credit cards)
- [ ] Structured logging uses message templates (no string interpolation)
- [ ] API responses don't return more data than needed (select specific fields)
- [ ] Database queries don't `SELECT *` when only specific columns needed

## 9. Dependency Security

**Checklist:**
- [ ] Lock files committed (`packages.lock.json`, `package-lock.json`, `Cargo.lock`, `poetry.lock`)
- [ ] Dependency audit run periodically (`dotnet list package --vulnerable`, `npm audit`, `cargo audit`, `pip-audit`)
- [ ] No known vulnerable dependencies in production
- [ ] Transitive dependencies reviewed for critical advisories

## 10. Secure Defaults

**Checklist:**
- [ ] HTTPS enforced (HSTS headers)
- [ ] CORS configured with specific origins, not `*`
- [ ] Debug mode disabled in production
- [ ] Default passwords changed
- [ ] Unnecessary endpoints/features disabled
- [ ] Security headers set (X-Content-Type-Options, X-Frame-Options, Referrer-Policy)

## Pre-Commit Security Gate

Run before every commit:

```
1. No hardcoded secrets?          → grep for API keys, passwords, tokens
2. All inputs validated?          → check new endpoints for schema validation
3. Queries parameterized?         → check for string concatenation in SQL
4. Auth on new endpoints?         → check for [Authorize] / RequireAuthorization
5. Error messages generic?        → no internal details in client responses
6. Logs clean?                    → no PII in log statements
7. Dependencies secure?           → run audit commands
```