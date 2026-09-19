-- Standardvy för försäljning i egenutvecklade butiker (Supabase/Postgres).
-- NeCom Data MCP läser ENBART denna vy (via service role). Anpassa SELECT-delen till projektets tabeller,
-- men behåll kolumnnamnen och typerna exakt. Persondata: bara en hash av kund-id/e-post, aldrig klartext.
--
-- Kolumner:
--   order_id       text        unik order-/betalningsreferens
--   created_at     timestamptz när ordern skapades (UTC)
--   status         text        'paid' | 'processing' | 'completed' räknas som betald; annat ignoreras
--   net_amount     numeric     belopp exkl. moms och frakt, i SEK
--   gross_amount   numeric     belopp inkl. moms och frakt (det kunden betalade)
--   currency       text        'SEK'
--   channel        text        t.ex. 'web', 'pos', 'etsy', 'tradera', 'event'
--   utm_source     text        från första/sista klick, om ni sparar det (t.ex. 'meta', 'google')
--   utm_medium     text
--   utm_campaign   text
--   customer_hash  text        md5(lower(email)) eller hash av user_id – för återkommande-andel
--   is_test        boolean     true för testordrar

-- ===== Exempel: Dogshowpro (registrations + mollie_payments) =====
create or replace view public.v_sales as
select
  r.id::text                                   as order_id,
  r.created_at                                 as created_at,
  case when lower(coalesce(r.payment_status,'')) = 'paid' then 'paid' else coalesce(r.payment_status,'unpaid') end as status,
  round(coalesce(r.payment_amount_sek, r.amount_sek, 0) / 1.06, 2) as net_amount,   -- 6 % moms på anmälningsavgift? justera
  coalesce(r.payment_amount_sek, r.amount_sek, 0)::numeric as gross_amount,
  'SEK'                                        as currency,
  coalesce(r.source_site, r.source, 'web')     as channel,
  (r.order_meta->>'utm_source')                as utm_source,
  (r.order_meta->>'utm_medium')                as utm_medium,
  (r.order_meta->>'utm_campaign')              as utm_campaign,
  md5(r.user_id::text)                         as customer_hash,
  coalesce(r.is_test, false)                   as is_test
from public.registrations r;

-- Endast service role får läsa vyn (RLS på underliggande tabeller gäller inte för service role).
revoke all on public.v_sales from anon, authenticated;

-- ===== Mall för ett nytt Next.js-projekt med tabellen orders =====
-- create or replace view public.v_sales as
-- select o.id::text, o.created_at, o.status, o.subtotal_ex_vat, o.total, 'SEK', o.channel,
--        o.utm_source, o.utm_medium, o.utm_campaign, md5(lower(o.email)), coalesce(o.is_test,false)
-- from public.orders o;
