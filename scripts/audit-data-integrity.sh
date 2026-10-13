#!/usr/bin/env bash
# audit-data-integrity.sh — 上线验收：跨表数据完整性稽核（只读，绝不写库）
#
# 判据来源：服装外贸 ERP 的账务底线。
# ⚠️ 口径纪律（本脚本 v2 修正）：只报**真矛盾**，不报正常业务态。
#    曾被 v1 误报的（已剔除）：
#      · 「部分核销/未核销 ⇒ 发票额 > Σ核销额」—— 这是**正常态**，不是缺陷
#      · 「应付发票用人民币而订单是美元」—— 应付侧本币结算，正常
#    真矛盾只包括：超额核销、状态与核销额冲突、引用悬空、日期倒挂、
#                  出运/开票累计超订单额、报关报额与应收发票额（同币种）严重不符。
#
# 用法：bash scripts/audit-data-integrity.sh [dbname]
set -uo pipefail

DB="${1:-panda_hub_local}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PW="$(grep -m1 '^DATABASE_URL' "$ROOT/server/.env" | sed -n 's|.*://bambook:\([^@]*\)@.*|\1|p')"
export PGPASSWORD="$PW"
Q() { psql -h localhost -U bambook -d "$DB" -t -A -F' | ' -c "$1" 2>&1; }
SEC() { printf '\n══════ %s ══════\n' "$1"; }

SEC "0. 基线（未删行）"
Q "select 'Order='||(select count(*) from \"Order\" where \"deletedAt\" is null)
        ||' Invoice='||(select count(*) from \"Invoice\" where \"deletedAt\" is null)
        ||' Shipment='||(select count(*) from \"Shipment\" where \"deletedAt\" is null)
        ||' PV='||(select count(*) from \"PaymentVoucher\" where \"deletedAt\" is null)
        ||' CD='||(select count(*) from \"CustomsDeclaration\" where \"deletedAt\" is null)
        ||' CreditNote='||(select count(*) from \"CreditNote\");"

SEC "1★ 超额核销：Σ appliedAmount > 发票额（真错账）"
Q "select i.\"invoiceNumber\", i.type, i.status, i.amount, i.currency,
          coalesce(sum(p.\"appliedAmount\"),0) as applied,
          round(coalesce(sum(p.\"appliedAmount\"),0) - i.amount, 4) as over
   from \"Invoice\" i
   join \"PaymentVoucher\" p on p.\"invoiceId\" = i.id and p.\"deletedAt\" is null
   where i.\"deletedAt\" is null
   group by i.id, i.\"invoiceNumber\", i.type, i.status, i.amount, i.currency
   having coalesce(sum(p.\"appliedAmount\"),0) > i.amount + 0.005
   order by (coalesce(sum(p.\"appliedAmount\"),0) - i.amount) desc limit 15;"

SEC "2★ 状态与核销额冲突"
Q "select 'A) status=Paid 但核销不足' as kind, count(*) from (
     select i.id from \"Invoice\" i
     left join \"PaymentVoucher\" p on p.\"invoiceId\"=i.id and p.\"deletedAt\" is null
     where i.\"deletedAt\" is null and i.status='Paid'
     group by i.id, i.amount having coalesce(sum(p.\"appliedAmount\"),0) < i.amount - 0.005) t
   union all
   select 'B) status=Issued/Draft 却有核销额', count(*) from (
     select i.id from \"Invoice\" i
     join \"PaymentVoucher\" p on p.\"invoiceId\"=i.id and p.\"deletedAt\" is null
     where i.\"deletedAt\" is null and i.status in ('Draft','Issued')
     group by i.id having sum(p.\"appliedAmount\") > 0.005) t
   union all
   select 'C) status=Paid 却缺 settlementDate', count(*) from \"Invoice\"
     where \"deletedAt\" is null and status='Paid' and \"settlementDate\" is null;"

SEC "3★ 引用悬空：子单指向不存在/已删的父单"
Q "select 'CD.shipmentId 悬空' as kind, count(*) from \"CustomsDeclaration\" c
     where c.\"deletedAt\" is null and c.\"shipmentId\" is not null
       and not exists (select 1 from \"Shipment\" s where s.id=c.\"shipmentId\" and s.\"deletedAt\" is null)
   union all
   select 'CD.orderId 悬空', count(*) from \"CustomsDeclaration\" c
     where c.\"deletedAt\" is null and c.\"orderId\" is not null
       and not exists (select 1 from \"Order\" o where o.id=c.\"orderId\" and o.\"deletedAt\" is null)
   union all
   select 'Invoice.orderId 悬空', count(*) from \"Invoice\" i
     where i.\"deletedAt\" is null and i.\"orderId\" is not null
       and not exists (select 1 from \"Order\" o where o.id=i.\"orderId\" and o.\"deletedAt\" is null)
   union all
   select 'PV.invoiceId 悬空', count(*) from \"PaymentVoucher\" p
     where p.\"deletedAt\" is null and p.\"invoiceId\" is not null
       and not exists (select 1 from \"Invoice\" i where i.id=p.\"invoiceId\" and i.\"deletedAt\" is null)
   union all
   select 'OrderLine.orderId 悬空', count(*) from \"OrderLine\" l
     where not exists (select 1 from \"Order\" o where o.id=l.\"orderId\")
   union all
   select 'OSB.orderId 悬空', count(*) from \"OrderShipmentBatch\" b
     where not exists (select 1 from \"Order\" o where o.id=b.\"orderId\")
   union all
   select 'Shipment.orderId 悬空', count(*) from \"Shipment\" s
     where s.\"deletedAt\" is null and s.\"orderId\" is not null
       and not exists (select 1 from \"Order\" o where o.id=s.\"orderId\" and o.\"deletedAt\" is null);"

SEC "4★ 日期倒挂"
Q "select '出运 atd 早于订单 poDate' as kind, count(*) from \"Shipment\" s
     join \"Order\" o on o.id = s.\"orderId\"
     where s.\"deletedAt\" is null and s.atd is not null and o.\"poDate\" is not null and s.atd < o.\"poDate\"
   union all
   select '发票 issueDate 早于订单 poDate', count(*) from \"Invoice\" i
     join \"Order\" o on o.id = i.\"orderId\"
     where i.\"deletedAt\" is null and o.\"poDate\" is not null and i.\"issueDate\" < o.\"poDate\"
   union all
   select '收款 paymentDate 早于发票 issueDate', count(*) from \"PaymentVoucher\" p
     join \"Invoice\" i on i.id = p.\"invoiceId\"
     where p.\"deletedAt\" is null and p.\"paymentDate\" < i.\"issueDate\"
   union all
   select '出运 atd 晚于到港 ata', count(*) from \"Shipment\"
     where \"deletedAt\" is null and atd is not null and ata is not null and ata < atd;"

SEC "5★ 数量超发（明细行 shipmentQuantity > quantity）"
Q "select l.\"orderId\", l.\"lineNumber\", l.quantity, l.\"shipmentQuantity\"
   from \"OrderLine\" l
   where l.\"shipmentQuantity\" is not null and l.\"shipmentQuantity\" > l.quantity + 0.0001
   order by (l.\"shipmentQuantity\" - l.quantity) desc limit 15;"

SEC "6★ 应收发票币种 ≠ 订单应收币种（只查 Receivable；应付本币结算属正常）"
Q "select o.\"poNumber\", o.\"salesCurrency\" as order_ccy, i.\"invoiceNumber\", i.currency as inv_ccy, i.amount
   from \"Invoice\" i join \"Order\" o on o.id = i.\"orderId\"
   where i.\"deletedAt\" is null and i.type = 'Receivable'
     and o.\"salesCurrency\" is not null and o.\"salesCurrency\" <> i.currency
   limit 15;"

SEC "7★ 分批出运累计计划额 > 订单额"
Q "select o.\"poNumber\", o.\"salesCurrency\" as ccy,
          round((select sum(coalesce(nullif(l.\"netValue\",''),0)) from \"OrderLine\" l where l.\"orderId\"=o.id)::numeric,2) as order_amt,
          round(sum(coalesce(b.amount,0))::numeric,2) as batch_amt
   from \"OrderShipmentBatch\" b join \"Order\" o on o.id=b.\"orderId\"
   where o.\"deletedAt\" is null and b.status <> 'cancelled'
   group by o.id, o.\"poNumber\", o.\"salesCurrency\"
   having sum(coalesce(b.amount,0)) > (select coalesce(sum(coalesce(nullif(l.\"netValue\",''),0)),0) from \"OrderLine\" l where l.\"orderId\"=o.id) + 0.5
   limit 15;"

SEC "8△ 报关报额 vs 应收发票额（同币种，差异 >1%）—— 供人判读，非自动定错"
Q "select o.\"poNumber\", i.currency as ccy,
          round(sum(i.amount)::numeric,2) as receivable_inv,
          (select round(sum(c.\"totalValue\")::numeric,2) from \"CustomsDeclaration\" c
             where c.\"orderId\"=o.id and c.\"deletedAt\" is null and c.currency=i.currency) as declared
   from \"Invoice\" i join \"Order\" o on o.id=i.\"orderId\"
   where i.\"deletedAt\" is null and i.type='Receivable'
   group by o.id, o.\"poNumber\", i.currency
   having (select sum(c.\"totalValue\") from \"CustomsDeclaration\" c
             where c.\"orderId\"=o.id and c.\"deletedAt\" is null and c.currency=i.currency) is not null
      and abs((select sum(c.\"totalValue\") from \"CustomsDeclaration\" c
             where c.\"orderId\"=o.id and c.\"deletedAt\" is null and c.currency=i.currency) - sum(i.amount))
          > sum(i.amount) * 0.01
   limit 12;"

SEC "9△ 出口出运缺报关单（业务上必须报关）"
Q "select count(*) from \"Shipment\" s
   where s.\"deletedAt\" is null and s.type='Export' and s.status in ('Shipped','Arrived','Cleared','Delivered')
     and not exists (select 1 from \"CustomsDeclaration\" c where c.\"shipmentId\"=s.id and c.\"deletedAt\" is null);"

SEC "10△ 贷项通知单状态与开放额自相矛盾"
Q "select 'amount 为负' as kind, count(*) from \"CreditNote\" where amount < 0
   union all
   select 'openAmount > amount 或 < 0', count(*) from \"CreditNote\" where \"openAmount\" > amount + 0.005 or \"openAmount\" < -0.005
   union all
   select 'status=Closed 但 openAmount<>0', count(*) from \"CreditNote\" where status='Closed' and abs(\"openAmount\") > 0.005;"

printf '\n══════ 稽核结束（★ 项为空 = 通过；△ 项需业务判读）══════\n'
