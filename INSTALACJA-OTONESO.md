# Instalacja Callback na otoneso.pl

## Dla właściciela strony (otoneso.pl, eprpilot.com, każdy klient)

Wystarczą cztery kroki w WordPressie. Nie trzeba kopiować kodu ani kluczy.

1. **Wtyczki → Dodaj nową → Wyślij wtyczkę na serwer** → wybierz `callback-widget.zip` → **Zainstaluj** → **Włącz**.
2. W menu po lewej kliknij **Callback** (ikona słuchawki).
3. Wpisz **numer telefonu**, na który mamy dzwonić. E-mail jest już podpowiedziany.
4. Kliknij **Włącz widget**.

Gotowe. Widget pojawia się na stronie od razu, a konto w panelu zakłada się samo.
Przycisk **Otwórz panel** we wtyczce loguje do panelu bez hasła. Tam są leady, statystyki, godziny pracy, kolory i teksty.

> Jeśli widget nie pojawia się po włączeniu, wyczyść cache (LiteSpeed, WP Rocket, Cloudflare).

## Jednorazowo: serwer Callback (robi to właściciel platformy, czyli Ty)

Wtyczka łączy się z serwerem `https://callback.otoneso.pl`. Trzeba go postawić raz, dla wszystkich stron i klientów.

1. VPS z Dockerem (np. Hetzner CX22) i rekord DNS `A`: `callback.otoneso.pl` → IP serwera.
2. Na serwerze:
   ```bash
   cp .env.example .env     # ustaw ADMIN_PASSWORD, PUBLIC_URL, CONTACT_EMAIL, dane Twilio
   docker compose up -d     # HTTPS ustawia się automatycznie
   ```
3. Twilio (prawdziwe połączenia): konto, numer (polski wymaga Regulatory Bundle z danymi firmy), w *Voice → Geo permissions* włączona Polska, dane w `.env`.

Adresy po uruchomieniu:
- `https://callback.otoneso.pl` – landing page produktu (z działającym widgetem),
- `https://callback.otoneso.pl/app/` – panel klienta (rejestracja i logowanie),
- `https://callback.otoneso.pl/admin/` – Twój panel: wszyscy klienci, ich plany i leady.

Wtyczkę pobieraj zawsze z landing page (przycisk „Pobierz wtyczkę”). Serwer wpisuje w nią swój adres automatycznie, więc działa z każdą domeną.

### Wdrożenie bez własnego serwera
- **Railway:** New Project → Deploy from GitHub repo (plik `railway.json` jest gotowy) → dodaj Volume zamontowany w `/data` → zmienne z `.env.example` → własna domena `callback.otoneso.pl`.
- **Render:** New → Blueprint → repozytorium (plik `render.yaml` jest gotowy, dysk na dane tworzy się sam).

## Bez WordPressa

Klient zakłada konto na `/app/?register`, a w zakładce **Strony i ustawienia** kopiuje jedną linię kodu i wkleja ją przed `</body>`.
