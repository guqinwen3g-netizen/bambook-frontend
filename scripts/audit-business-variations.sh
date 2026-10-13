#!/usr/bin/env bash
# audit-business-variations.sh — 业务变异对撞（只读）
# 目的：找出「不报错但算错」的口径级问题。判据来源 = shared/openReceivable.ts / invoiceSettlementBasis.ts
set -uo pipefail
DB="${1:-panda_hub_local}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PW="$(grep -m1 '^DATABASE_URL' "$ROOT/server/.env" | sed -n 's|.*://bambook:\([^@]*\)@.*|\1|p')"
export PGPASSWORD="$PW"
Q() { psql -h localhost -U bambook -d "$DB" -t -A -F' | ' -c "$1" 2>&1; }
SEC() { printf '\n══════ %s ══════\n' "$1"; }

SEC "A. 少收汇：已核销>0 但不足额（含差额规模）"
Q "select i.\"invoiceNumber\", i.type, i.status, i.amount, i.currency,
          coalesce(sum(p.\"appliedAmount\"),0) as applied,
          round((i.amount - coalesce(sum(p.\"appliedAmount\"),0))::numeric,2) as open,
          count(p.id) as n_pv
   from \"Invoice\" i
   left join \"PaymentVoucher\" p on p.\"invoiceId\"=i.id and p.\"deletedAt\" is null
   where i.\"deletedAt\" is null and i.status='PartiallyPaid' and i.amount > 0
   group by i.id, i.\"invoiceNumber\", i.type, i.status, i.amount, i.currency
   order by open desc limit 10;"

SEC "B. 银行手续费是否参与核销（voucher.amount vs bankFee）"
Q "select count(*) as pv_total,
          count(*) filter (where \"bankFee\" is not null and \"bankFee\" > 0) as with_fee,
          count(*) filter (where \"bankFee\" > 0 and \"appliedAmount\" is not null and abs(\"appliedAmount\" - amount) < 0.005) as fee_but_full_applied
   from \"PaymentVoucher\" where \"deletedAt\" is null;"
Q "select \"voucherNumber\", amount, \"bankFee\", \"appliedAmount\", currency
   from \"PaymentVoucher\"
   where \"deletedAt\" is null and \"bankFee\" > 0
   order by \"bankFee\" desc limit 8;"

SEC "C. 跨币种核销：voucher.currency ≠ invoice.currency"
Q "select p.\"voucherNumber\", p.currency as pv_ccy, p.amount as pv_amt, p.\"appliedAmount\" as applied,
          i.\"invoiceNumber\", i.currency as inv_ccy, i.amount as inv_amt
   from \"PaymentVoucher\" p join \"Invoice\" i on i.id=p.\"invoiceId\"
   where p.\"deletedAt\" is null and p.currency <> i.currency limit 10;"
Q "select 'voucher 有 exchangeRate' as k, count(*) filter (where \"exchangeRate\" is not null) as n_with,
          count(*) as n_all
   from \"PaymentVoucher\" where \"deletedAt\" is null;"

SEC "D. 贷项（索赔/折让）是否挂到原发票、是否影响应收"
Q "select count(*) as cn_total,
          count(*) filter (where \"appliedToInvoiceId\" is not null) as linked_to_invoice,
          count(*) filter (where status='Closed') as closed,
          count(*) filter (where \"refundedAt\" is not null) as refunded
   from \"CreditNote\";"
Q "select \"creditNoteNumber\", currency, amount, \"openAmount\", status, \"appliedToInvoiceId\" is not null as has_inv
   from \"CreditNote\" order by amount desc limit 8;"

SEC "E. 分批出运：批次计划额之和 vs 订单额（修正数值类型）"
Q "select o.\"poNumber\", o.\"salesCurrency\",
          round((select coalesce(sum(l.\"netValue\"),0) from \"OrderLine\" l where l.\"orderId\"=o.id)::numeric,2) as order_amt,
          round(coalesce(sum(b.amount),0)::numeric,2) as batch_amt,
          count(b.id) as n_batch
   from \"OrderShipmentBatch\" b join \"Order\" o on o.id=b.\"orderId\"
   where o.\"deletedAt\" is null and b.status <> 'cancelled'
   group by o.id, o.\"poNumber\", o.\"salesCurrency\"
   having abs(coalesce(sum(b.amount),0) - (select coalesce(sum(l.\"netValue\"),0) from \"OrderLine\" l where l.\"orderId\"=o.id)) > 0.5
   order by abs(coalesce(sum(b.amount),0) - (select coalesce(sum(l.\"netValue\"),0) from \"OrderLine\" l where l.\"orderId\"=o.id)) desc
   limit 10;"

SEC "F. 批次结算状态 vs 批次金额（settleStatus 与 invoiced/paid 快照是否自洽）"
Q "select b.\"batchNo\", b.status, b.\"settleStatus\", b.amount, b.\"invoicedAmount\", b.\"paidAmount\"
   from \"OrderShipmentBatch\" b
   where b.status <> 'cancelled' and b.\"settleStatus\"='settled'
     and (b.\"paidAmount\" is null or b.\"paidAmount\" < b.amount - 0.5)
   limit 10;"

SEC "G. 贸易条款：报关 tradeTerms 分布 + CIF 是否带运费保费"
Q "select coalesce(\"tradeTerms\",'(空)') as terms, count(*) as n,
          count(*) filter (where \"freightAmount\" is not null) as with_freight,
          count(*) filter (where \"insuranceAmount\" is not null) as with_ins
   from \"CustomsDeclaration\" where \"deletedAt\" is null group by 1 order by 2 desc;"

printf '\n══════ 变异对撞结束（空 = 该项无异常）══════\n'
