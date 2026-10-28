---
title: "MemoCall — anonimowość i dane osobowe: inwentarz stanu faktycznego, luki i rekomendacje"
created: 2026-08-04
type: privacy-audit
---

# Anonimowość w MemoCall — co kod robi naprawdę

> **Produkt tego dokumentu to INWENTARZ + rekomendacje.** Nie jest to plan refaktoru
> (patrz 02, 03) ani porada prawna — nazwy z RODO pojawiają się jako opis ryzyka, nie jako
> wykładnia. Wszystkie cytaty `plik:linia` zweryfikowane odczytem w tej sesji; twierdzenia
> negatywne („nigdzie nie ma X") — grepem, którego zakres jest w Aneksie.
>
> Dokumenty poprzedzające: [`01-domain-distillation.md`](./01-domain-distillation.md),
> [`02-invariant-aggregate-refactor.md`](./02-invariant-aggregate-refactor.md),
> [`03-anti-corruption-layer.md`](./03-anti-corruption-layer.md).

**Teza w jednym zdaniu:** od FR-025 (2026-10-20) MemoCall **świadomie zapisuje, z kim była
rozmowa** — numer od operatora i jego nazwę prezentacji przy każdej nowej rozmowie, wąsko
i ze strażnikami (A-1) — i **wcale nie jest anonimowy w treści** (transkrypt leży jawnie
i przechodzi przez dwóch procesorów, I-1). Pierwsza właściwość jest od tego dnia decyzją
z testami; druga nadal powstała bez decyzji.

> Do 2026-10-20 teza brzmiała odwrotnie w pierwszej połowie: „numer rozmówcy nigdzie nie
> jest zapisywany", właściwość przypadkowa i niczym niebroniona. FR-025 zamienił ją na
> zaprojektowaną odwrotność — patrz A-1.

---

## KROK 0 — Kto jest kim w tym systemie

| Rola | Kto | Uwaga |
| --- | --- | --- |
| Operator / jedyny użytkownik | solo profesjonalista (`userId = 'me'`, `api/trpc.ts:33`) | w ujęciu RODO: administrator danych rozmówcy |
| **Podmiot danych, który nigdy nie widział panelu** | **druga strona rozmowy** | nie ma konta, nie wyraża zgody, nie jest informowany — patrz L-3 |
| Procesor 1 | operator telefonii — Zadarma (Łotwa; wcześniej Twilio EU) | zna numery obu stron; nagranie kasujemy, rekord połączenia zostaje; od FR-025 to z jego statystyk bierzemy numer rozmówcy (A-1) |
| Procesor 2 | Deepgram Nova-3 (EU) | dostaje **audio**, nie dostaje metadanych telefonicznych |
| Procesor 3 | AWS Bedrock / Claude Haiku 4.5 (EU) | dostaje **tekst transkryptu**, nie dostaje audio ani numerów |
| Host | Fly.io `fra` | wolumen szyfrowany at-rest, 5 auto-snapshotów (CLAUDE.md) |

Rozmówca jest jedyną osobą w tym systemie, która **nie ma żadnego interfejsu** — ani do zgody,
ani do wglądu, ani do usunięcia. Cały ciężar jest po stronie operatora. To jest oś, wokół której
układają się wszystkie luki poniżej.

---

## KROK 1 — Co JEST anonimowe lub pseudonimowe (z dowodami)

### A-1. Numer i nazwa rozmówcy — gdzie leżą, jak tam trafiają, czego nie robią

> **Przepisane 2026-10-20** przy wdrożeniu `caller-identity-in-archive` (FR-025 w `prd.md`,
> wariant **C** decyzji S-06 z 2026-10-16: „chcę wiedzieć, jaki numer, i móc przypisać
> etykietę"). Zastępuje ustalenie z 2026-08-04 („numer rozmówcy nie istnieje w naszej bazie")
> i jego dwie korekty (`dialed_numbers` 2026-08-04, `contacts` 2026-09-15). Tamte zdania były
> prawdą o kodzie do dnia wdrożenia; ich historia jest w gicie, nie tutaj.

**Stan w jednym akapicie.** Numer telefonu może leżeć w **trzech** tabelach. Tylko jedna z nich
wiąże numer z konkretnym nagraniem — `conversations` — i tylko ona trzyma numer, którego
użytkownik nie wpisał. Robi to wąsko: jedna ścieżka zapisu, jeden stan przejściowy, zero
odtwarzania wstecz.

| Tabela | Co trzyma | Skąd pochodzi | Związek z rozmową |
| --- | --- | --- | --- |
| `conversations` — `counterparty_e164`, `counterparty_name_hint`, `counterparty_state` | numer drugiej strony **wg operatora** + nazwa prezentacji z `clid` (**podpowiedź**, nigdy rozstrzygająca) + stan | statystyki PBX Zadarmy, wyłącznie przez `runCounterpartySweep` (`jobs/counterparty.ts`) | **wprost** — ten sam wiersz co nagranie |
| `contacts.e164` | numer przypisany do nazwy nadanej przez użytkownika | wpisany w panelu **albo** skopiowany z `counterparty_e164` jednym świadomym klikiem (`conversations.labelCounterparty`) | brak FK; widok łączy po **wartości** numeru |
| `dialed_numbers.e164` | numery wybrane w `/call` | wpisane w panelu | brak FK, brak `call_sid`; `last_used_at` to zegar ścienny |

**Jak numer trafia do `conversations`.**

- `NOTIFY_RECORD` **nie niesie numeru** (trzy pola). Wstawienie rozmowy (`jobs/backfill.ts`,
  wspólne dla webhooka i sweepu uzgadniającego) zapisuje stałą `counterparty_state = 'pending'`
  i nic poza tym — `BackfillInput` nie ma pola na numer.
- Co ~5 min, w tym samym takcie co sweep uzgadniający, `runCounterpartySweep` pyta statystyki
  PBX o okno 48 h i dla każdej rozmowy `pending` robi `UPDATE … WHERE counterparty_state =
  'pending'` na jeden z trzech stanów końcowych: `known` (numer + opcjonalna podpowiedź),
  `withheld` (operator nie podał numeru — CLIR), `unavailable` (brak wiersza statystyk przez
  24 h **albo** kandydat okazał się własnym GSM użytkownika — liczone jako `selfRefused`).
- Reguła wyboru nogi (zmierzona, `context/changes/caller-identity-in-archive/spike.md`):
  rozmowa przychodząca → `clid`, wychodząca → `destination`. `clid` przy wychodzącej to
  **własny** numer użytkownika — dlatego odrzucenie własnego GSM jest licznikiem
  w `telephony.counterparty.sweep`, a nie zgadywaniem.
- Postać kanoniczna przed zapisem: numer polski przez `normalizePolishE164` (ta sama funkcja,
  którą pisze książka kontaktów, więc złączenie działa bajt w bajt), inny jako `+` i cyfry.
- **Jedna ścieżka zapisu jest wymuszona**, nie umówiona: `jobs/counterparty-write-path.test.ts`
  wywraca zestaw, jeśli nazwy kolumn pojawią się w `src/server` poza sweepem, schematem
  i routerem odczytu.
- **Rozmowy sprzed wdrożenia mają `counterparty_state IS NULL` i nigdy nie dostaną numeru** —
  ani migracją, ani skryptem przez `fly ssh` (decyzja właściciela z pre-mortemu 2026-10-19).
  Wymusza to SQL: `NULL = 'pending'` nigdy nie jest prawdą.
- Pod Twilio i mockiem nie ma rozwiązywacza (metoda jest opcjonalna, implementuje ją tylko
  Zadarma) — rozmowy przechodzą w `unavailable` po 24 h.

**Czego numer i podpowiedź NIE robią** (każdy punkt ma strażnika w kodzie):

- nie trafiają do LLM — A-5;
- nie trafiają do logów ani do `processing_jobs.last_error` — A-6;
- nie trafiają do indeksu wyszukiwania: triggery FTS (`drizzle/0005`) reagują tylko na
  `transcript_segments` i `analysis`, a sweep pisze wyłącznie kolumny rozmówcy;
- nie trafiają do URL ani do stanu UI: filtr listy trzyma `contactId`, nie numer;
- przeglądarka **nigdy nie wysyła numeru** — `labelCounterparty` dostaje id rozmowy i cel
  (istniejący kontakt bez numeru albo nazwę nowego), numer czyta z wiersza po stronie serwera;
- tekst podpowiedzi jest czyszczony ze znaków sterujących i znaków kierunku tekstu (bidi)
  przy mapowaniu (`zadarma-counterparty.ts`), bo pochodzi od operatora, czyli z niezaufanego
  źródła; renderowany jako tekst, bez HTML.

**Kasowanie.** Usunięcie rozmowy usuwa numer i podpowiedź razem z wierszem — nie ma czego
kaskadować. Dwa świadome wyjątki: numer skopiowany do `contacts` przez etykietę należy od tej
chwili do kontaktu i rozmowę przeżywa (to osobny rekord użytkownika), oraz snapshoty wolumenu
(I-6). Usunięcie kontaktu nie dotyka rozmów: wiersz wraca do podpowiedzi albo numeru, bo
złączenie jest po wartości, a nie przez `contact_id`.

**Linkowalność `dialed_numbers`.** Dawny punkt tej sekcji mówił o korelacji
`dialed_numbers.last_used_at` ↔ `conversations.started_at`. Był nieścisły dwa razy: pod Zadarmą
`started_at` jest zawsze `NULL` (korelować dało się tylko z `createdAt`), a od FR-025 korelacja
jest zbędna — rozmowa wychodząca niesie numer wprost. `dialed_numbers` i `contacts` nadal nie
mają `call_sid` ani klucza obcego do rozmowy; nota w `CLAUDE.md` §Database schema mówi, czego
dodanie któregoś z nich wymaga.

**Znane ograniczenie, poza zakresem FR-025:** numery i nazwiska **wypowiedziane w rozmowie**
leżą w transkrypcie (I-1) i jako jego część idą do STT i LLM. Nic ich nie wykrywa ani nie
maskuje — redakcja z A-6 dotyczy logów, nie treści.

### A-2. Mówcy są pseudonimizowani etykietą kanału

```ts
// src/server/stt/deepgram.ts:42-44
function speakerLabel(channelIndex: number): string {
	// 0 → "Speaker A", 1 → "Speaker B", …
	return `Speaker ${String.fromCharCode(65 + channelIndex)}`;
}
```

Etykieta pochodzi z **fizycznego kanału** nagrania dual-channel (`:93`, `:123`), nie z
rozpoznawania mówcy. Nie ma diarizacji per osoba, nie ma odcisku głosu, nie ma powiązania
etykiety z żadną tożsamością.

### A-3. Audio nigdy nie ląduje na naszym dysku

Worker mostkuje Twilio → Deepgram jednym `TransformStream` — pull i upload biegną równolegle,
nic nie jest materializowane:

```
src/server/jobs/worker.ts:178-181   const bridge = new TransformStream<Uint8Array>();
src/server/jobs/worker.ts:187       .streamRecording({ recordingSid }, bridge.writable, …)
src/server/jobs/worker.ts:208       open: () => bridge.readable
```

Grep po `writeFile`/`tmpdir` w tej ścieżce nie zwraca niczego. Plik audio nie istnieje po naszej
stronie ani przez moment — nie ma go też w snapshotach wolumenu.

### A-4. Nagranie jest kasowane u dostawcy, ze stemplem kontrolnym

Trzy niezależne ścieżki kasowania: po sukcesie zadania (`worker.ts:441-444`), zamiatarka
ponawiająca nieudane kasowania (`scheduler.ts:107-117`, co ~30 s wg `DELETE_SWEEP_EVERY_N_TICKS`),
oraz kasowanie przy usuwaniu rozmowy z panelu (`conversations.ts:517-521`). Stan jest
audytowalny kolumną `recording_deleted_at` (`db/schema.ts:64-66`).

### A-5. Do LLM idzie sam transkrypt — zero metadanych telefonicznych

`analyze()` buduje prompt z tekstu transkryptu i słownika **własnych tagów** użytkownika;
`classify()` dokłada listę **własnych projektów operatora** (`id`, `name`, `category`) — to dane
operatora, nie rozmówcy. Nigdzie nie trafia `callSid`, data, identyfikator rozmowy, **numer
rozmówcy ani podpowiedź operatora** (FR-025).

Od FR-025 broni tego test, nie tylko odczyt kodu:

- typy wejścia: `AnalyzeInput` ma dokładnie transkrypt i słownik, `ClassifyInput` dokładnie
  transkrypt i projekty — asercje typów w `llm/analyze.test.ts` i `llm/classify.test.ts`
  nie przejdą, gdy ktoś doda pole;
- oba workery: rozmowa `known` z numerem i podpowiedzią przechodzi przez `processJob`
  i `reanalyzeJob`, a test sprawdza, że żaden z promptów nie zawiera ani numeru, ani
  podpowiedzi (`jobs/worker.test.ts`, `jobs/reanalyze.test.ts`).

Wyjątek, którego nie da się domknąć tą drogą: numer **wypowiedziany** w rozmowie jest częścią
transkryptu i trafia do LLM jak każde inne słowo (A-1, „Znane ograniczenie").

### A-6. Logi audytu nie niosą treści rozmowy ani numerów

Wszystkie sinki logów (stderr, czyli okno `fly logs` ~7 dni) i pole
`processing_jobs.last_error`:

| Moduł | Zdarzenia | Pola | Numer / nazwa |
| --- | --- | --- | --- |
| zadania | `job.*` | `jobId`, `conversationId`, `status`, `attemptCount`, `errorCode`, `error` | `error` przez sanitizer |
| auth | logowanie, throttle, lockout | `ip`, `userId`, `attemptCount`, `retryAfterMs`, `error` — **IP operatora**, nie rozmówcy | `error` przez sanitizer |
| połączenia | `call.placed`, `call.place_failed`, `call.history_write_failed` | `userId`, `callSid`, błąd | **numer odbiorcy nie jest logowany**; błąd przez sanitizer (test z prawdziwym `DrizzleQueryError`) |
| rozmowy | `conversation.*`, w tym `conversation.counterparty_labeled` | `userId`, `conversationId`, `contactId` | **ani nazwy, ani numeru** — dokładny zestaw kluczy sprawdza test routera |
| kontakty, projekty, tagi | `contact.*`, `project.*`, `tag.*` | id (`contactId`, `conversationId`, `tagId`) | kontakty: bez nazwy i numeru; tagi: z nazwą — patrz I-5 |
| ingress telefonii | `telephony.ingress.*` | `path`, `kind`, `bodyBytes`, `signed`, `outcome` | treść żądania nigdy, tylko liczba bajtów |
| sweep rozmówcy | `telephony.counterparty.sweep` | wyłącznie liczniki (`pending`, `resolved`, `withheld`, `expired`, `selfRefused`, `selfInbound`, `unparsed`, `unmatched`) | żadnego id, numeru ani podpowiedzi |
| sweep rozmówcy — błąd | `telephony.counterparty.failed` | `errorCode`, `error` | `error` przez sanitizer; komunikaty błędów dostawcy w tej ścieżce to stały tekst |
| uzgadnianie, Zadarma | `telephony.reconcile.*`, `telephony.zadarma.*` | liczniki, id | komunikaty dostawcy przez `redactVendorMessage` (maskowanie **przed** cięciem do 120 znaków) |
| worker boot | `event`, `ts`, `requeued` | — | — |

**Mechanizm, nie umowa** (od fazy 2 `caller-identity-in-archive`):

- `safeErrorMessage` (`_lib/redact.ts`) to jedyny dozwolony sposób zamiany błędu na tekst:
  najpierw odcina ogon `params:` z `DrizzleQueryError` (wartości związane nieudanego zapytania,
  czyli np. numer lub nazwa), potem maskuje caller-id `"Nazwa" <+48…>` i numery w tekście,
  dopiero potem przycina — w odwrotnej kolejności przycięcie rozcinałoby numer na dwie
  niewykrywalne połówki;
- `_lib/redact-sinks.test.ts` wywraca zestaw, jeśli którykolwiek `console.error`, logger audytu
  albo zapis `lastError` w `src` czyta `.message` / `.stack` / `String(err)` bezpośrednio;
- znane dziury maskowania (cyfry sklejone z literami, kropki jako separator, serie 6 i 16+
  cyfr) są przypięte tabelą „known gaps" w `redact.test.ts`, a nie przemilczane;
- do przeglądarki: `errorFormatter` w `api/trpc.ts` zamienia treść każdego owiniętego obcego
  błędu (`INTERNAL_SERVER_ERROR` z `cause`) na stałą i zdejmuje `stack`, więc surowy
  `DrizzleQueryError` z numerem w `params` nie trafia do odpowiedzi tRPC.

Jeden wyjątek treściowy — patrz I-5 (tagi). Konsola przeglądarki: nieudane wywołanie tRPC jest
wypisywane z wejściem (`loggerLink`), więc wpisana nazwa kontaktu może się tam pojawić — tylko
lokalnie, u jedynego użytkownika; zaakceptowane w przeglądzie fazy 5.

### A-7. Historia edycji transkryptu nie przechowuje treści

`transcript_edits` ma wyłącznie `id`, `user_id`, `conversation_id`, `edited_at`
(`db/schema.ts:170-190`). Audyt faktu edycji, nie jej zawartości — minimalizacja danych zrobiona
prawidłowo i przy okazji zgodna z FR-020.

### A-8. Operator jest w systemie prawie anonimowy

Brak e-maila, nazwiska, konta. `userId` to literał `'me'` (`api/trpc.ts:33`), jedyne dane to hash
hasła (`auth_config.password_hash`) i IP w logach logowania. Brak flow rejestracji, brak recovery
mailowego (świadoma decyzja: `prd.md:271` — „avoids GDPR consent surface for recovery emails").

---

## KROK 2 — Co JEDNAK identyfikuje

### I-1. Treść — i to jest główna, nieusuwalna nie-anonimowość

Transkrypt (`transcript_segments`) i analiza (`analysis`) są zapisane **jawnie** w SQLite na
wolumenie. Wolumen jest szyfrowany at-rest po stronie Fly, ale **nie ma szyfrowania na poziomie
kolumn ani aplikacji** — kto ma `fly ssh console`, czyta wszystko (i CLAUDE.md wprost opisuje
taką ścieżkę w „Emergency / one-off fallbacks"). W rozmowie biznesowej padają nazwiska, nazwy
firm, kwoty, ustalenia — i **numery telefonów wypowiedziane na głos**, których redakcja
z A-6 nie dotyczy (działa na logach, nie na treści). Pseudonimizacja mówców (A-2) tego nie
zmienia.

### I-2. Twilio wie wszystko, czego my nie wiemy

Kasujemy **nagranie**, nie **rekord połączenia**. Numery obu stron, czas i `CallSid` zostają
w koncie Twilio zgodnie z jego retencją. PRD odnotowuje to uczciwie: „delete przez Twilio API
jest natychmiastowy na poziomie dostępu … ale ma vendor-udokumentowany ogon ≤30 dni
backend-purge + ~40 dni okno metadanych" (`prd.md:134`).

### I-3. Linkowalność: `call_sid` jest kluczem obcym do tożsamości

Trzymamy `call_sid` i `recording_sid` (`db/schema.ts:62-63`) — trwałe identyfikatory po stronie
vendora. **Anonimowość naszej bazy jest więc relacyjna, nie bezwzględna**: mając naszą bazę
*oraz* dostęp do konta Twilio, każdą „anonimową" rozmowę da się przypisać do numeru. Dla modelu
zagrożeń „ktoś przejmuje sam panel" to działa; dla „ktoś ma jedno i drugie" — nie.

Od FR-025 dotyczy to już tylko rozmów **sprzed wdrożenia** (`counterparty_state IS NULL`)
i rozmów bez numeru (`withheld` / `unavailable`). Rozmowa `known` niesie numer wprost (A-1)
i do jej przypisania sama baza wystarcza.

### I-4. Outbound przepuszcza numer przez panel

`calls.placeOutbound` przyjmuje numer odbiorcy, normalizuje go (`calls.ts:20-23`) i przekazuje do
operatora. Do logu **nie trafia** (loguje się tylko `callSid`). Do bazy **trafia** dwukrotnie:
ta sama procedura zapisuje go do historii wybieranych numerów (`dialed_numbers`, od
2026-08-04, bez powiązania z rozmową), a od FR-025 sweep rozmówcy zapisuje go przy rozmowie,
którą to połączenie nagrało (A-1).
Ale numer jest w treści żądania HTTP, więc żyje tak długo, jak logi warstwy transportowej
u hostera — czego nie kontrolujemy w kodzie.

### I-5. Nazwy tagów trafiają do logów

```ts
// src/server/api/routers/tags.ts:235-241 (fragment)
	conversationId: string;
	name?: string;      // ← nazwa tagu w logu stderr
	tagId?: string;
	merged?: boolean;
…
console.error(JSON.stringify({ ts: Date.now(), event, ...fields }));
```

Tag bywa generowany przez LLM z treści rozmowy (`analysis.candidateTags` → `worker.ts:414`) albo
wpisany ręcznie. Nic nie broni tagu `kowalski-umowa-najmu`. To jedyny kanał, którym fragment
treści wycieka do logów Fly (retencja ~7 dni wg `jobs/audit.ts:8`). Ryzyko małe, ale realne
i tanie do usunięcia.

### I-6. Snapshoty wolumenu przeżywają usunięcie rozmowy

Usunięcie rozmowy w panelu kasuje wiersz + kaskadowo tagi, edycje i zadania (FK
`ON DELETE CASCADE`, `db/schema.ts:156`, `:181`, `:212`, egzekwowane przez `PRAGMA foreign_keys`
w `db/index.ts:22`). Ale wolumen Fly ma 5 automatycznych snapshotów (CLAUDE.md) — dane usunięte
dziś są odtwarzalne z wczorajszego snapshotu. „Usunięte" znaczy „usunięte z bazy roboczej", nie
„usunięte wszędzie".

Od FR-025 dotyczy to także **numeru i podpowiedzi operatora**: usunięcie rozmowy kasuje je
z wiersza natychmiast, ale snapshoty wyznaczają górną granicę faktycznego usunięcia — numer
znika z wolumenu dopiero wtedy, gdy wypadnie z ostatniego z 5 zachowanych snapshotów.
Etykieta w `contacts` jest osobnym rekordem i usunięcie rozmowy jej nie dotyczy (A-1).

**Druga resztka, na samym wolumenie (przegląd całego planu FR-025, 2026-10-20):** kasowanie
w SQLite jest logiczne. Żadne połączenie nie ustawia `PRAGMA secure_delete`, więc bajty
usuniętego wiersza — numer, podpowiedź, ale też transkrypt i analiza — zostają w wolnych
stronach pliku `/data/db.sqlite` (i w WAL do checkpointu), dopóki SQLite ich nie nadpisze.
Trafiają więc także do snapshotów zrobionych **po** usunięciu. Nie dotyczy to wyłącznie
FR-025; włączenie pragmy to osobna decyzja (więcej zapisów przy każdym `DELETE`, a strony
zwolnione wcześniej i tak zostają).

---

## KROK 3 — Ścieżka danych oczami rozmówcy

```
rozmówca dzwoni / odbiera
   │
   ├─ operator (Zadarma) numer OBU stron, czas, id         → zostaje u vendora (I-2)
   │                      nagranie                        → kasowane przez nas (A-4)
   │                      statystyki PBX (numer + nazwa)  → czytane co ~5 min przez sweep (A-1)
   │
   ├─ nasz worker ....... audio przelatuje strumieniem    → NIC nie ląduje na dysku (A-3)
   │
   ├─ Deepgram (EU) ..... audio                           → transkrypt; bez numerów z metadanych (A-5)
   │
   ├─ Bedrock (EU) ...... tekst transkryptu               → analiza; bez numeru, podpowiedzi i audio (A-5)
   │
   └─ nasza baza ........ transkrypt + analiza + tagi     → JAWNIE, bezterminowo (I-1, L-4)
                          call_sid / recording_sid        → klucz linkujący do operatora (I-3)
                          numer + nazwa od operatora      → przy rozmowie, kasowane z nią (A-1, I-6)
                          etykieta (contacts)             → tylko po kliknięciu użytkownika (A-1)
```

Skutek produktowy, świadomie potwierdzony decyzją z 2026-10-16: **panel wie, z kim była
rozmowa** — dla rozmów nagranych od wdrożenia FR-025. Wiersz listy pokazuje nazwę kontaktu,
podpowiedź od operatora albo numer; lista filtruje się po kontakcie. Rozmowy sprzed wdrożenia
nadal nie wiedzą, z kim były, i nigdy się nie dowiedzą (A-1, brak odtwarzania wstecz).

---

## KROK 4 — Luki: co deklarujemy, a czego w kodzie nie ma

| # | Deklaracja | Stan kodu | Waga |
| --- | --- | --- | --- |
| **L-1** | „Audit logging across cloud hops. Każda interakcja z cloud STT i cloud LLM logged (operation type, timestamp, request size, latency) — nie payload content" (`prd.md:104`) | **niespełnione** — logujemy przejścia zadania (`jobs/audit.ts:10-19`); grep po `latency`/`bytes`/`requestSize` w `src/server` nie zwraca niczego z tej ścieżki | średnia — to guardrail, nie „nice to have" |
| **L-2** | „Data portability. Wszystkie persystowane dane użytkownika … są eksportowalne w open formats (JSON i/lub Markdown) — żadnego vendor lock-in po stronie danych" (`prd.md:107`) | **brak** — żadna procedura tRPC nie eksportuje (stan 2026-10-20: 25 definicji `.query`/`.mutation` w `api/routers/*.ts`, w tym router `contacts`; inwentarz z 2026-08-04 liczył 17) | średnia |
| **L-3** | poinformowanie drugiej strony o nagrywaniu | **brak i nieadresowane** — TwiML to samo `<Dial record="record-from-answer-dual">` bez `<Say>` (`telephony/twilio.ts:101-110` inbound, `:134-141` outbound); w `prd.md` i `shape-notes.md` **brak wątku zgody/informowania** — jedyne trafienia „GDPR" dotyczą e-maili do resetu hasła (`prd.md:256`, `:271`) | **wysoka** |
| **L-4** | ograniczenie przechowywania / retencja | **brak** — rozmowy leżą bezterminowo; jedyna zamiatarka (`scheduler.ts:91-125`) kasuje **nagrania u dostawcy**, nie stare rozmowy; jedyne kasowanie danych to ręczne `conversations.delete` (`:490`) | wysoka |
| **L-5** | realizacja żądania „usuń moje dane" od osoby trzeciej | **łatwiejsza od FR-025, ale niepełna** — dla rozmów od wdrożenia jest po czym szukać (filtr po kontakcie po nadaniu etykiety; numer przy rozmowie), lecz nie ma wyszukiwania po surowym numerze; rozmowy sprzed wdrożenia — tylko przeszukanie treści; numery wypowiedziane w transkrypcie (I-1) i snapshoty (I-6) bez zmian | średnia |
| **L-6** | świadome udokumentowanie A-1 | **domknięte 2026-10-20** — A-1 jest decyzją (FR-025), opisaną w CLAUDE.md i w komentarzu schematu, z czterema strażnikami w testach (jedna ścieżka zapisu, brak numeru w promptach, sanitizer z testem sinków, klucze audytu) | — |

---

## KROK 5 — Rekomendacje (kolejność wg stosunku wartości do kosztu)

| # | Działanie | Miejsce w kodzie | Koszt |
| --- | --- | --- | --- |
| **R-1** | ~~Zamrozić A-1 jako decyzję „numer nigdy nie jest zapisywany"~~ — **nieaktualne**: właściciel rozstrzygnął odwrotnie (FR-025). Zamiast zamrożenia braku zamrożono **wąskość** zapisu: test jednej ścieżki zapisu (`jobs/counterparty-write-path.test.ts`) i stała `'pending'` przy insercie | `jobs/counterparty.ts`, `jobs/backfill.ts` | zrobione |
| **R-2** | **Retencja z TTL** — „kasuj rozmowy starsze niż `RETENTION_DAYS`" jako czwarta zamiatarka; infrastruktura już jest (pętla, kadencja, wzorzec delete-sweep), brakuje jednej kwerendy + zmiennej env | `jobs/scheduler.ts:91-125` (wzorzec), `src/env.js` | ~2 h |
| **R-3** | **Opcjonalna zapowiedź nagrywania** — `<Say>` przed `<Dial>`, sterowane env (`RECORDING_NOTICE_PL`), domyślnie włączone dla inbound; domyka L-3 najtaniej jak się da | `telephony/twilio.ts:101-110` i `:134-141` | ~1 h |
| **R-4** | **Eksport JSON** — nowa procedura `conversations.export` (albo `data.export`) zwracająca transkrypt + analizę + tagi + projekty; domyka L-2 i daje ścieżkę realizacji żądań podmiotu danych | nowy plik w `api/routers/` | ~3 h |
| **R-5** | **Audyt wywołań cloud** — `latency_ms` i `bytes`/`chars` przy wywołaniach STT/LLM; domyka guardrail L-1, przy okazji daje pierwszą realną obserwowalność kosztów | `jobs/worker.ts` wokół `deps.transcribe` / `deps.analyze` | ~2 h |
| **R-6** | **Usunąć `name` z logu tagów** (albo skracać do długości/hasha) — domyka I-5 | `api/routers/tags.ts:235-241` | ~15 min |
| **R-8** | **Szczelna redakcja logów i `last_error`** — wspólny sanitizer zamiast maski `\d{6,}` po cięciu do 120 znaków (która przepuszczała numery z separatorami i rozcięte cięciem) i zamiast surowego `err.message` (które drukowało `params:` z `DrizzleQueryError`); strażnik źródłowy na wszystkie sinki | `_lib/redact.ts`, `_lib/redact-sinks.test.ts` | zrobione (FR-025, faza 2) |
| **R-7** | *(opcjonalnie, większe)* rozważyć zerwanie linkowalności I-3: kasować `call_sid`/`recording_sid` po potwierdzonym `recording_deleted_at` | `jobs/worker.ts:441-444`, `scheduler.ts:107-117` | ~3 h + decyzja produktowa (traci się idempotencję webhooka po czasie) |

R-1 i R-8 są zrobione (FR-025). R-3 i R-6 razem to jeden wieczór i domykają pozostałe tanie luki. R-2 i R-4 to naturalna
jedna zmiana („retencja i eksport"), bo dotykają tej samej warstwy.

---

## KROK 6 — Decyzje, które musi podjąć właściciel produktu

1. **Czy brak numeru rozmówcy to cecha, czy brak?** Jeśli cecha — R-1. Jeśli brak (bo chcemy
   filtrować rozmowy po kontrahencie) — trzeba to zaprojektować świadomie: kolumna, podstawa
   przetwarzania, retencja, i wtedy A-1 przestaje istnieć. **Nie zostawiać w stanie „przypadkiem".**
   → **Rozstrzygnięte 2026-10-16: BRAK.** Zaprojektowane jako FR-025 w PRD; podstawa i
   retencja odłożone do PRD Open Questions #7 i #9, które wiążą się z pkt 2 i 3 poniżej.
2. **Czy informujemy drugą stronę o nagrywaniu?** Techniczny koszt jest zerowy (R-3); to jest
   decyzja produktowa i relacyjna, nie inżynierska.
3. **Jaki jest okres przechowywania rozmowy?** Bezterminowo jest decyzją, nawet jeśli nikt jej
   nie podjął. Wybór `RETENTION_DAYS` odblokowuje R-2.
4. **Czy dopuszczamy pełny eksport?** Jeśli tak — R-4 domyka też deklarowany brak vendor lock-inu.
5. **Czy model zagrożeń obejmuje „napastnik ma nasz panel *i* konto Twilio"?** Jeśli tak — R-7;
   jeśli nie — I-3 zostaje udokumentowanym, akceptowanym ryzykiem.

---

## Aneks — zakres weryfikacji

**Odczytane w całości:** `src/server/telephony/{types,webhooks,twilio,phone,index}.ts`,
`src/server/api/routers/calls.ts`, `src/server/jobs/audit.ts`, `src/server/auth/audit.ts`,
`src/instrumentation.ts`, `src/server/db/schema.ts`, `src/server/llm/{analyze,classify}.ts`.

**Odczytane fragmentarycznie:** `src/server/jobs/worker.ts` (115-130, 178-210 + grep),
`src/server/jobs/scheduler.ts` (grep tematyczny), `src/server/api/routers/{conversations,tags}.ts`
(fragmenty audytu + kasowania), `src/server/stt/deepgram.ts` (grep po etykietach mówców),
`context/foundation/prd.md` i `shape-notes.md` (grep tematyczny), `README.md`, `CLAUDE.md`.

**Twierdzenia negatywne i ich dowody:**

| Twierdzenie | Polecenie | Wynik |
| --- | --- | --- |
| numer rozmówcy jest zapisywany tylko przez sweep (od 2026-10-20; zastępuje dawne „nie jest zapisywany") | `jobs/counterparty-write-path.test.ts` (część `npm test`) | kolumny `counterparty_*` wyłącznie w sweepie, schemacie i routerze odczytu |
| numer i podpowiedź nie trafiają do promptów | `npx vitest run src/server/llm src/server/jobs/worker.test.ts src/server/jobs/reanalyze.test.ts` | asercje typów wejścia + prompty bez numeru i podpowiedzi |
| żaden sink logów nie czyta `.message` bezpośrednio | `npx vitest run src/server/_lib/redact-sinks.test.ts` | zielone |
| brak eksportu danych | inwentarz 17 procedur w `api/routers/*.ts` | brak procedury eksportującej |
| brak audytu latencji/rozmiaru wywołań cloud | `grep -rn -i "latency\|bytes\|requestSize\|elapsed" src/server` | trafienia tylko w komentarzach i w `auth/lockout.ts` |
| brak zapowiedzi nagrywania | `grep -rn "Say\|say(\|announce" src/server/telephony/twilio.ts` | pusto |
| brak retencji rozmów | `grep -n -i "sweep\|older\|retention\|cleanup" src/server/jobs/scheduler.ts` | `runBootSweep`, `runDeleteSweep` (nagrania), `runReconcileSweep` (brakujące rozmowy) i wywołanie `runCounterpartySweep` (numer rozmówcy) — żaden nie kasuje starych rozmów |
| audio nie ląduje na dysku | `grep -n "TransformStream\|writeFile\|tmpdir" src/server/jobs/worker.ts` | tylko most `TransformStream` (`:178-208`) |

**Czego NIE zweryfikowano:** (a) faktycznej retencji i ustawień prywatności po stronie kont
Twilio / Deepgram / AWS (to jest w dashboardach vendorów, nie w repo); (b) czy warstwa
transportowa Fly loguje ciała żądań (dotyczy I-4); (c) rzeczywistej zawartości snapshotów
wolumenu (I-6 wynika z opisu konfiguracji w CLAUDE.md, nie z inspekcji snapshotu);
(d) stanu prawnego — dokument opisuje ryzyka, nie rozstrzyga zgodności.
