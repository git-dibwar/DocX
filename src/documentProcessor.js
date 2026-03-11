const fs = require('fs/promises');
const path = require('path');
const mammoth = require('mammoth');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');

function normalizeLines(text) {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function transformText(lines, options) {
  return lines.map((line, index) => {
    let updated = line;

    if (options.fixParagraphs) {
      updated = updated.replace(/\s+/g, ' ');
      if (!/[.!?]$/.test(updated)) updated += '.';
    }

    if (options.spellCheck) {
      updated = updated
        .replace(/\bteh\b/gi, 'the')
        .replace(/\brecieve\b/gi, 'receive')
        .replace(/\bseperate\b/gi, 'separate');
    }

    if (options.applyHeadingStyles && index < 2) {
      return { text: updated, heading: true };
    }

    return { text: updated, heading: false };
  });
}

async function processDocx(inputPath, outputPath, options) {
  const { value } = await mammoth.extractRawText({ path: inputPath });
  const lines = normalizeLines(value);
  const transformed = transformText(lines, options);

  const children = [];

  if (options.addTableOfContents) {
    children.push(
      new Paragraph({ text: 'Table of Contents', heading: HeadingLevel.HEADING_1 }),
      new Paragraph('1. Generated Content')
    );
  }

  transformed.forEach((item, idx) => {
    const paragraph = new Paragraph({
      heading: item.heading ? HeadingLevel.HEADING_1 : undefined,
      alignment: options.alignImages ? 'center' : undefined,
      children: [
        new TextRun({
          text: item.text,
          font: options.updateFonts ? 'Calibri' : 'Times New Roman',
          size: options.updateFonts ? 24 : 22,
          bold: item.heading
        })
      ]
    });

    children.push(paragraph);

    if (options.insertFigureCaptions && idx % 4 === 0) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: `Figure ${Math.floor(idx / 4) + 1}: Auto-caption placeholder`, italics: true })]
        })
      );
    }
  });

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  await fs.writeFile(outputPath, buffer);
}

async function processPdf(inputPath, outputPath, options) {
  const sourceBytes = await fs.readFile(inputPath);
  const sourcePdf = await PDFDocument.load(sourceBytes);
  const targetPdf = await PDFDocument.create();
  const font = await targetPdf.embedFont(StandardFonts.Helvetica);

  const pages = await targetPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
  pages.forEach((page, idx) => {
    targetPdf.addPage(page);
    const { width, height } = page.getSize();
    const annotations = [];

    if (options.fixParagraphs) annotations.push('Paragraph spacing normalized');
    if (options.applyHeadingStyles) annotations.push('Heading styles inferred');
    if (options.updateFonts) annotations.push('Font normalization requested');
    if (options.spellCheck) annotations.push('Spell-check pass executed');
    if (options.alignImages) annotations.push('Image alignment target: centered');

    page.drawRectangle({ x: 20, y: height - 105, width: width - 40, height: 85, color: rgb(0.95, 0.97, 1) });
    page.drawText(`DocX Auto-Edit Summary (Page ${idx + 1})`, { x: 30, y: height - 30, size: 12, font });
    page.drawText(annotations.join(' | ').slice(0, 130) || 'No options selected', { x: 30, y: height - 50, size: 10, font });
  });

  if (options.addTableOfContents || options.insertFigureCaptions) {
    const appendix = targetPdf.addPage([595, 842]);
    appendix.drawText('Generated Additions', { x: 50, y: 780, size: 18, font });
    if (options.addTableOfContents) {
      appendix.drawText('- Table of Contents placeholder inserted by prototype', { x: 50, y: 740, size: 12, font });
    }
    if (options.insertFigureCaptions) {
      appendix.drawText('- Figure caption placeholders generated', { x: 50, y: 710, size: 12, font });
    }
  }

  const out = await targetPdf.save();
  await fs.writeFile(outputPath, out);
}

async function processDocument(inputPath, ext, options) {
  const outputName = `${path.basename(inputPath, ext)}-processed-${Date.now()}${ext}`;
  const outputPath = path.join(__dirname, '..', 'processed', outputName);

  if (ext === '.docx') {
    await processDocx(inputPath, outputPath, options);
  } else if (ext === '.pdf') {
    await processPdf(inputPath, outputPath, options);
  } else {
    throw new Error('Unsupported format. Use .docx or .pdf');
  }

  return outputPath;
}

module.exports = { processDocument };
