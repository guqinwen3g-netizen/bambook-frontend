#!/usr/bin/env node

/**
 * Panda 样品发票生成器 (Invoice Generator)
 * 
 * 功能: 根据 JSON 数据生成 PDF 格式的样品发票
 * 格式复刻: Panda 样品发票模板 (PDAS/PDRS)
 * 
 * 使用方法:
 *   node invoice-generator.js --input <json文件> --output <pdf输出路径>
 *   node invoice-generator.js --test  // 运行测试
 * 
 * @author Charlie (小陈)
 * @date 2026-04-14
 */

const fs = require('fs');
const path = require('path');

// 检查 PDFKit 是否可用（生产环境需要安装）
let PDFDocument;
try {
  PDFDocument = require('pdfkit');
} catch (e) {
  console.warn('⚠️  pdfkit 未安装，将生成 HTML 替代版本');
  PDFDocument = null;
}

// ==================== 配置常量 ====================

const COMPANY_INFO = {
  name: 'Jiangsu Panda Clothing Co.,Ltd.',
  address: 'ROOM A1028 WUYUE PLAZA',
  city: 'ZHANGJIAGANG CITY,215600 PR',
  country: 'CHINA'
};

const BANK_INFO = {
  name: 'BANK OF CHINA ZHANGJIAGANG SUB-BRANCH',
  swift: 'BKCHCNBJ95L',
  account: '467668133096',
  currency: 'USD'
};

const PAYMENT_TERMS = 'AS PER AGREEMENT';

// 发票类型前缀
const INVOICE_TYPES = {
  SAMPLE: 'PDAS',      // Panda Sample 样品发票
  REGULAR: 'PDRS'      // Panda Regular Sample 常规样品
};

// ==================== 发票生成器类 ====================

class InvoiceGenerator {
  
  /**
   * 构造函数
   * @param {Object} options - 生成选项
   */
  constructor(options = {}) {
    this.doc = null;
    this.outputPath = options.outputPath || 'invoice.pdf';
    this.usePDF = options.usePDF !== false && PDFDocument !== null;
    this.items = [];
  }

  /**
   * 生成发票编号
   * @param {string} type - 发票类型 (SAMPLE/REGULAR)
   * @param {Date} date - 日期
   * @param {string} suffix - 后缀 (K/P)
   */
  generateInvoiceNumber(type = 'SAMPLE', date = new Date(), suffix = 'K') {
    const prefix = INVOICE_TYPES[type] || INVOICE_TYPES.SAMPLE;
    const yy = String(date.getFullYear()).slice(-2);
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${prefix}${yy}${mm}${dd}${suffix}`;
  }

  /**
   * 格式化日期
   * @param {Date} date 
   */
  formatDate(date = new Date()) {
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];
    return `${date.getFullYear()} ${months[date.getMonth()]} ${date.getDate()}`;
  }

  /**
   * 设置发票明细项
   * @param {Array} items - 发票明细数组
   */
  setItems(items) {
    this.items = items;
  }

  /**
   * 计算总金额
   */
  calculateTotal() {
    return this.items.reduce((sum, item) => {
      const qty = parseFloat(item.qty) || 0;
      const unitPrice = parseFloat(item.unitPrice) || 0;
      return sum + (qty * unitPrice);
    }, 0);
  }

  /**
   * 生成 PDF 格式发票
   * @param {Object} data - 发票数据
   */
  async generatePDF(data) {
    const doc = new PDFDocument({ margin: 50 });
    const writeStream = fs.createWriteStream(this.outputPath);
    doc.pipe(writeStream);

    const { billTo, poNumber, items, shipTo, invoiceDate, invoiceNumber } = data;
    
    // ===== 头部公司信息 =====
    doc.fontSize(16)
       .font('Helvetica-Bold')
       .text(COMPANY_INFO.name, { align: 'center' });
    
    doc.fontSize(10)
       .font('Helvetica')
       .text(COMPANY_INFO.address, { align: 'center' })
       .text(`${COMPANY_INFO.city}`, { align: 'center' })
       .text(COMPANY_INFO.country, { align: 'center' });

    doc.moveDown(2);

    // ===== 发票标题 =====
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .text('SAMPLE INVOICE', { align: 'center' });

    doc.moveDown(1);

    // ===== 发票编号和日期 =====
    const leftX = 50;
    const rightX = 350;
    
    doc.fontSize(10)
       .font('Helvetica-Bold')
       .text('Invoice Number:', leftX)
       .text('Date:', rightX);
    
    doc.font('Helvetica')
       .text(invoiceNumber, leftX)
       .text(this.formatDate(invoiceDate ? new Date(invoiceDate) : new Date()), rightX);

    doc.moveDown(0.5);

    // ===== BILL TO =====
    doc.font('Helvetica-Bold')
       .text('BILL TO:')
       .font('Helvetica')
       .text(billTo.name || billTo);

    doc.moveDown(0.5);

    // ===== 明细表格 =====
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    
    // 表头
    const tableTop = doc.y + 5;
    doc.fontSize(8)
       .font('Helvetica-Bold');
    
    const headers = [
      { label: 'PO NUMBER', x: 50, w: 80 },
      { label: 'ZROH#', x: 130, w: 60 },
      { label: 'DESCRIPTION', x: 190, w: 150 },
      { label: 'QTY (M)', x: 340, w: 50 },
      { label: 'UNIT PRICE', x: 390, w: 70 },
      { label: 'AMOUNT (USD)', x: 460, w: 90 }
    ];

    headers.forEach(h => doc.text(h.label, h.x, tableTop, { width: h.w }));
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.3);

    // 表格内容
    doc.font('Helvetica').fontSize(8);
    let y = doc.y;
    
    items.forEach((item, index) => {
      if (y > 700) {
        doc.addPage();
        y = 50;
      }
      
      const rowData = [
        item.poNumber || poNumber || '-',
        item.zroh || '-',
        this.truncateText(item.description || item.fabric || '-', 40),
        item.qty || '-',
        `$${(parseFloat(item.unitPrice) || 0).toFixed(2)}`,
        `$${((parseFloat(item.qty) || 0) * (parseFloat(item.unitPrice) || 0)).toFixed(2)}`
      ];
      
      rowData.forEach((cell, i) => {
        doc.text(cell, headers[i].x, y, { width: headers[i].w });
      });
      
      y += 15;
    });

    doc.y = y + 10;
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.5);

    // ===== 总计 =====
    doc.font('Helvetica-Bold')
       .text(`TOTAL: $${this.calculateTotal().toFixed(2)} USD`, 400, doc.y + 5);

    doc.moveDown(1);

    // ===== SHIP TO =====
    if (shipTo) {
      doc.font('Helvetica-Bold').text('SHIP TO:');
      doc.font('Helvetica').text(shipTo);
      doc.moveDown(0.5);
    }

    // ===== 底部银行信息 =====
    doc.moveDown(1);
    doc.fontSize(9)
       .font('Helvetica-Bold')
       .text('Payment Terms:', 50)
       .font('Helvetica')
       .text(PAYMENT_TERMS, 130);
    
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold')
       .text('Bank Information:', 50);
    
    doc.font('Helvetica')
       .text(BANK_INFO.name, 50, doc.y + 10)
       .text(`SWIFT CODE: ${BANK_INFO.swift}`, 50)
       .text(`${BANK_INFO.currency} ACCOUNT: ${BANK_INFO.account}`, 50);

    // 完成
    doc.end();

    return new Promise((resolve, reject) => {
      writeStream.on('finish', () => resolve(this.outputPath));
      writeStream.on('error', reject);
    });
  }

  /**
   * 生成 HTML 格式发票（无 PDFKit 时的替代方案）
   * @param {Object} data - 发票数据
   */
  generateHTML(data) {
    const { billTo, poNumber, items, shipTo, invoiceDate, invoiceNumber } = data;
    // 必须先设置 items，calculateTotal 才能正确计算
    this.items = items || [];
    const total = this.calculateTotal();

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Sample Invoice - ${invoiceNumber}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 12px; padding: 40px; }
    .header { text-align: center; margin-bottom: 30px; }
    .company-name { font-size: 18px; font-weight: bold; }
    .company-address { font-size: 11px; color: #666; }
    .invoice-title { font-size: 16px; font-weight: bold; margin: 20px 0; text-align: center; }
    .info-row { display: flex; justify-content: space-between; margin-bottom: 20px; }
    .info-block { margin-bottom: 15px; }
    .info-label { font-weight: bold; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    th, td { border: 1px solid #333; padding: 8px; text-align: left; }
    th { background: #f0f0f0; font-weight: bold; }
    .text-right { text-align: right; }
    .total { font-size: 14px; font-weight: bold; text-align: right; margin: 15px 0; }
    .footer { margin-top: 40px; border-top: 1px solid #333; padding-top: 15px; }
    .footer p { margin: 3px 0; }
  </style>
</head>
<body>
  <div class="header">
    <div class="company-name">${COMPANY_INFO.name}</div>
    <div class="company-address">
      ${COMPANY_INFO.address}<br>
      ${COMPANY_INFO.city}<br>
      ${COMPANY_INFO.country}
    </div>
  </div>

  <div class="invoice-title">SAMPLE INVOICE</div>

  <div class="info-row">
    <div>
      <div class="info-block"><span class="info-label">Invoice Number:</span> ${invoiceNumber}</div>
      <div class="info-block"><span class="info-label">Date:</span> ${this.formatDate(invoiceDate ? new Date(invoiceDate) : new Date())}</div>
    </div>
  </div>

  <div class="info-block">
    <span class="info-label">BILL TO:</span><br>
    ${billTo.name || billTo}
  </div>

  <table>
    <thead>
      <tr>
        <th>PO NUMBER</th>
        <th>ZROH#</th>
        <th>DESCRIPTION</th>
        <th class="text-right">QTY (M)</th>
        <th class="text-right">UNIT PRICE (USD)</th>
        <th class="text-right">AMOUNT (USD)</th>
      </tr>
    </thead>
    <tbody>
      ${items.map(item => `
      <tr>
        <td>${item.poNumber || poNumber || '-'}</td>
        <td>${item.zroh || '-'}</td>
        <td>${item.description || item.fabric || '-'}</td>
        <td class="text-right">${item.qty || '-'}</td>
        <td class="text-right">$${(parseFloat(item.unitPrice) || 0).toFixed(2)}</td>
        <td class="text-right">$${((parseFloat(item.qty) || 0) * (parseFloat(item.unitPrice) || 0)).toFixed(2)}</td>
      </tr>`).join('')}
    </tbody>
  </table>

  <div class="total">TOTAL: $${total.toFixed(2)} USD</div>

  ${shipTo ? `<div class="info-block"><span class="info-label">SHIP TO:</span><br>${shipTo}</div>` : ''}

  <div class="footer">
    <p><span class="info-label">Payment Terms:</span> ${PAYMENT_TERMS}</p>
    <p><span class="info-label">Bank Information:</span> ${BANK_INFO.name}</p>
    <p>SWIFT CODE: ${BANK_INFO.swift}</p>
    <p>${BANK_INFO.currency} ACCOUNT: ${BANK_INFO.account}</p>
  </div>
</body>
</html>`;

    const htmlPath = this.outputPath.replace(/\.pdf$/i, '.html');
    fs.writeFileSync(htmlPath, html);
    return htmlPath;
  }

  /**
   * 截断文本
   */
  truncateText(text, maxLen) {
    if (!text) return '-';
    return text.length > maxLen ? text.substring(0, maxLen - 3) + '...' : text;
  }

  /**
   * 主生成方法
   * @param {Object} data - 发票数据
   */
  async generate(data) {
    console.log(`📄 开始生成发票: ${data.invoiceNumber || 'untitled'}`);
    
    if (this.usePDF) {
      await this.generatePDF(data);
      console.log(`✅ PDF 已生成: ${this.outputPath}`);
      return this.outputPath;
    } else {
      const htmlPath = this.generateHTML(data);
      console.log(`✅ HTML 已生成: ${htmlPath}`);
      console.log('💡 提示: 安装 pdfkit 可生成 PDF 格式');
      console.log('   npm install pdfkit');
      return htmlPath;
    }
  }
}

// ==================== 工具函数 ====================

/**
 * 从 JSON 文件加载发票数据
 */
function loadInvoiceData(jsonPath) {
  try {
    const content = fs.readFileSync(jsonPath, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    console.error(`❌ 读取文件失败: ${jsonPath}`);
    process.exit(1);
  }
}

/**
 * 验证发票数据
 */
function validateData(data) {
  const required = ['billTo', 'items'];
  const missing = required.filter(field => !data[field]);
  
  if (missing.length > 0) {
    console.error(`❌ 缺少必填字段: ${missing.join(', ')}`);
    return false;
  }
  
  if (!Array.isArray(data.items) || data.items.length === 0) {
    console.error('❌ items 必须是非空数组');
    return false;
  }
  
  return true;
}

// ==================== 测试用例 ====================

function runTests() {
  console.log('🧪 开始测试发票生成器...\n');
  
  const generator = new InvoiceGenerator();
  let passed = 0;
  let failed = 0;

  // 测试数据
  const testData = {
    invoiceNumber: generator.generateInvoiceNumber('SAMPLE', new Date('2026-04-14'), 'K'),
    invoiceDate: '2026-04-14',
    billTo: { name: 'ITOCHU PROMINENT USA LLC.' },
    poNumber: '4500159326',
    items: [
      {
        zroh: '156111',
        description: '70%WOOL/27%POLYESTER/3%SPANDEX - Navy Blue Suiting',
        qty: 50,
        unitPrice: 5.50
      },
      {
        zroh: '156112',
        description: '65%WOOL/35%POLYESTER - Grey Herringbone',
        qty: 30,
        unitPrice: 6.00
      }
    ],
    shipTo: '123 Fashion Ave, New York, NY 10001'
  };

  // 测试1: 发票编号生成
  console.log('📋 测试1: 发票编号生成');
  const invNum = generator.generateInvoiceNumber('SAMPLE', new Date('2026-04-14'), 'K');
  const expectedPattern = /^PDAS\d{6}[K|P]$/;
  if (expectedPattern.test(invNum)) {
    console.log(`   ✅ 通过: ${invNum}`);
    passed++;
  } else {
    console.log(`   ❌ 失败: 格式不正确 - ${invNum}`);
    failed++;
  }

  // 测试2: 日期格式化
  console.log('📋 测试2: 日期格式化');
  const formattedDate = generator.formatDate(new Date('2026-04-14'));
  if (formattedDate === '2026 April 14') {
    console.log(`   ✅ 通过: ${formattedDate}`);
    passed++;
  } else {
    console.log(`   ❌ 失败: ${formattedDate}`);
    failed++;
  }

  // 测试3: 总金额计算
  console.log('📋 测试3: 总金额计算');
  generator.setItems(testData.items);
  const total = generator.calculateTotal();
  const expectedTotal = 50 * 5.50 + 30 * 6.00; // 455
  if (Math.abs(total - expectedTotal) < 0.01) {
    console.log(`   ✅ 通过: $${total.toFixed(2)}`);
    passed++;
  } else {
    console.log(`   ❌ 失败: 期望 $${expectedTotal}, 实际 $${total}`);
    failed++;
  }

  // 测试4: 数据验证
  console.log('📋 测试4: 数据验证');
  if (validateData(testData)) {
    console.log('   ✅ 通过: 数据验证成功');
    passed++;
  } else {
    console.log('   ❌ 失败: 数据验证失败');
    failed++;
  }

  // 测试5: 生成实际发票
  console.log('📋 测试5: 生成实际发票文件');
  const testOutputPath = '/Users/qinwengu/WorkBuddy/Claw/knowledge-base/scripts/test-invoice.html';
  const gen = new InvoiceGenerator({ outputPath: testOutputPath, usePDF: false });
  
  gen.generate(testData).then(output => {
    if (fs.existsSync(output)) {
      console.log(`   ✅ 通过: 文件已生成 - ${output}`);
      passed++;
      
      // 清理测试文件
      fs.unlinkSync(output);
      console.log('   🧹 测试文件已清理');
    } else {
      console.log('   ❌ 失败: 文件未生成');
      failed++;
    }
    
    // 测试结果汇总
    console.log('\n' + '='.repeat(40));
    console.log(`📊 测试结果: ${passed} 通过, ${failed} 失败`);
    
    if (failed === 0) {
      console.log('🎉 所有测试通过!');
    } else {
      console.log('⚠️  部分测试失败，请检查代码');
      process.exit(1);
    }
  }).catch(e => {
    console.log(`   ❌ 失败: ${e.message}`);
    failed++;
    process.exit(1);
  });
}

// ==================== CLI 入口 ====================

function showHelp() {
  console.log(`
📄 Panda 样品发票生成器 (v1.0)
═══════════════════════════════════════════════

用法:
  node invoice-generator.js [选项]

选项:
  --input <json文件>   从 JSON 文件加载发票数据
  --output <路径>      指定输出文件路径 (默认: invoice.pdf)
  --test               运行测试用例
  --help               显示帮助信息

示例:
  # 生成发票
  node invoice-generator.js --input invoice-data.json --output my-invoice.pdf

  # 运行测试
  node invoice-generator.js --test

输入 JSON 格式:
{
  "invoiceNumber": "PDAS260414K",      // 可选，自动生成
  "invoiceDate": "2026-04-14",          // 可选，默认今天
  "billTo": "ITOCHU PROMINENT USA LLC.", // 必填
  "poNumber": "4500159326",              // 可选
  "items": [                             // 必填
    {
      "zroh": "156111",                  // ZROH编号
      "description": "面料描述",          // 商品描述
      "qty": 50,                         // 数量(米)
      "unitPrice": 5.50                  // 单价(USD)
    }
  ],
  "shipTo": "收货地址"                   // 可选
}

作者: Charlie (小陈)
日期: 2026-04-14
`);
}

// 解析命令行参数
const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help')) {
  showHelp();
  process.exit(0);
}

if (args.includes('--test')) {
  runTests();
  process.exit(0);
}

const inputIndex = args.indexOf('--input');
const outputIndex = args.indexOf('--output');

if (inputIndex === -1) {
  console.error('❌ 错误: 请指定输入文件 (--input)');
  showHelp();
  process.exit(1);
}

const inputPath = args[inputIndex + 1];
const outputPath = outputIndex !== -1 ? args[outputIndex + 1] : 'invoice.pdf';

// 加载并验证数据
const data = loadInvoiceData(inputPath);

if (!validateData(data)) {
  process.exit(1);
}

// 生成发票
const generator = new InvoiceGenerator({ outputPath });
generator.generate(data);

module.exports = { InvoiceGenerator, COMPANY_INFO, BANK_INFO };
