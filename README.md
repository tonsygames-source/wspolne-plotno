# Wspólne płótno

Prosta aplikacja do rysowania na jednym wspólnym płótnie, na żywo, dla dwóch osób. Działa jako PWA, więc da się ją dodać do ekranu głównego na iOS i Androidzie. Hostowana na Cloudflare (Workers + Durable Objects), darmowy plan wystarcza.

## Co potrafi

- wspólne płótno w czasie rzeczywistym (WebSocket), widzicie swoje kreski na bieżąco
- 8 kolorów, regulowana grubość, gumka
- Cofnij (cofa Twoją ostatnią kreskę), Wyczyść (czyści dla obojga), Zapisz jako PNG
- rysunek jest zapisany na serwerze, po zamknięciu aplikacji nadal tam jest
- jeśli zniknie internet, kreski czekają w kolejce i wysyłają się po powrocie połączenia
- wspólny kod pokoju działa jak hasło, bez kont i logowania

## Uruchomienie lokalnie

```bash
npm install
npm run dev
```

Otwórz adres z terminala na dwóch kartach i rysuj z tym samym kodem.

## Wdrożenie na Cloudflare

Potrzebne darmowe konto Cloudflare i Node.js.

**Opcja A, z komputera:**

```bash
npm install
npx wrangler login
npm run deploy
```

Na końcu dostaniesz adres w stylu `https://wspolne-plotno.TWOJA-NAZWA.workers.dev`.

**Opcja B, automatycznie z GitHuba:**

1. Wrzuć to repo na GitHuba.
2. W panelu Cloudflare wejdź w Workers & Pages → Create → Import a repository.
3. Wybierz repo. Polecenie deploy zostaw domyślne (`npx wrangler deploy`).
4. Od teraz każdy push na `main` sam wdraża nową wersję.

## Dodanie do ekranu głównego

- **iPhone:** otwórz adres w Safari → Udostępnij → "Dodaj do ekranu początkowego".
- **Android:** otwórz adres w Chrome → menu (⋮) → "Zainstaluj aplikację" lub "Dodaj do ekranu głównego".

Na iOS aplikacja z ekranu głównego ma osobną pamięć niż Safari, więc kod pokoju wpisz jeszcze raz już w samej aplikacji (przycisk "Kod").

## Prywatność

Każdy, kto zna kod pokoju, widzi i rysuje na waszym płótnie. Wybierzcie długi, trudny do zgadnięcia kod (np. kilka losowych słów). Jeśli chcecie mieć pewność, można dodatkowo zabezpieczyć cały adres przez Cloudflare Access (Zero Trust, darmowe do 50 użytkowników), wtedy wejść mogą tylko wasze dwa adresy e-mail.

## Struktura

```
src/worker.js   Worker + Durable Object DrawRoom (pokój, zapis kresek)
public/         aplikacja: index.html, app.js, style.css, manifest, sw.js, ikony
wrangler.jsonc  konfiguracja Cloudflare
```

## Pomysły na później

- przybliżanie i przesuwanie płótna
- więcej płócien (np. osobny kod na każdy rysunek)
- czułość na nacisk rysika
- kursor drugiej osoby na żywo
