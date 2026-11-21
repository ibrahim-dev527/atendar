// Report export: PDF, Excel (.xlsx), Word (.docx). Libraries are bundled in /vendor
// and loaded only when an export is requested.
const stamp = () => new Date().toLocaleString("en-GB", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
const safeName = (s) => String(s).replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").slice(0, 80) || "report";

function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const text = (v) => (v == null ? "" : String(v));

/**
 * @param {{format:'pdf'|'xlsx'|'docx', title:string, subtitle?:string,
 *   columns:{key:string,label:string}[], rows:Record<string,any>[],
 *   summary?:[string,string|number][], filename:string}} o
 */
export async function exportTable(o) {
  const name = safeName(o.filename);
  if (o.format === "pdf") return toPdf(o, name);
  if (o.format === "xlsx") return toXlsx(o, name);
  if (o.format === "docx") return toDocx(o, name);
  throw new Error("Unknown export format");
}

async function toPdf(o, name) {
  const { jsPDF, autoTable } = await import("/vendor/pdf.js");
  const doc = new jsPDF({ orientation: o.columns.length > 6 ? "landscape" : "portrait", unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  doc.setFillColor(20, 16, 86); doc.rect(0, 0, W, 78, "F");
  doc.setFillColor(34, 211, 238); doc.rect(0, 78, W, 3, "F");
  doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.text(o.title, 36, 38);
  doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  doc.text("Atendar · Classroom Attendance", 36, 56);
  doc.text(`Generated ${stamp()}`, 36, 69);
  let y = 100;
  doc.setTextColor(40);
  if (o.subtitle) { doc.setFontSize(10); doc.text(doc.splitTextToSize(o.subtitle, W - 72), 36, y); y += 16 * Math.ceil(o.subtitle.length / 110); }
  if (o.summary?.length) {
    doc.setFontSize(10); doc.setFont("helvetica", "bold");
    o.summary.forEach(([k, v], i) => { const col = i % 3, row = Math.floor(i / 3); doc.text(`${k}: ${text(v)}`, 36 + col * ((W - 72) / 3), y + row * 15); });
    y += Math.ceil(o.summary.length / 3) * 15 + 8;
    doc.setFont("helvetica", "normal");
  }
  autoTable(doc, {
    startY: y, head: [o.columns.map((c) => c.label)], body: o.rows.map((r) => o.columns.map((c) => text(r[c.key]))),
    styles: { fontSize: 8.5, cellPadding: 4 }, headStyles: { fillColor: [20, 16, 86], textColor: 255 }, alternateRowStyles: { fillColor: [244, 246, 255] },
    margin: { left: 36, right: 36, bottom: 40 },
    didDrawPage: (d) => {
      const H = doc.internal.pageSize.getHeight();
      doc.setFontSize(8); doc.setTextColor(120);
      doc.text("Powered by Ibratechh · ibratechh.com", 36, H - 18);
      doc.text(`Page ${d.pageNumber}`, W - 36, H - 18, { align: "right" });
    },
  });
  if (!o.rows.length) { doc.setFontSize(11); doc.text("No records match the selected filters.", 36, doc.lastAutoTable?.finalY + 24 || y + 40); }
  download(doc.output("blob"), `${name}.pdf`);
}

async function toXlsx(o, name) {
  const X = await import("/vendor/xlsx.js");
  const aoa = [[o.title], ["Atendar · Classroom Attendance"], [`Generated ${stamp()}`]];
  if (o.subtitle) aoa.push([o.subtitle]);
  aoa.push([]);
  (o.summary || []).forEach(([k, v]) => aoa.push([k, v]));
  if (o.summary?.length) aoa.push([]);
  const headerRow = aoa.length;
  aoa.push(o.columns.map((c) => c.label));
  o.rows.forEach((r) => aoa.push(o.columns.map((c) => r[c.key] ?? "")));
  aoa.push([], ["Powered by Ibratechh · https://ibratechh.com"]);
  const ws = X.utils.aoa_to_sheet(aoa); // values are written as typed cells, never as formulas
  ws["!cols"] = o.columns.map((c) => ({ wch: Math.min(40, Math.max(c.label.length + 2, ...o.rows.slice(0, 200).map((r) => text(r[c.key]).length + 2))) }));
  ws["!autofilter"] = { ref: X.utils.encode_range({ s: { r: headerRow, c: 0 }, e: { r: headerRow + o.rows.length, c: o.columns.length - 1 } }) };
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, ws, "Report");
  const out = X.write(wb, { bookType: "xlsx", type: "array" });
  download(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${name}.xlsx`);
}

async function toDocx(o, name) {
  const D = await import("/vendor/docx.js");
  const cell = (t, { head = false, w } = {}) => new D.TableCell({
    width: w ? { size: w, type: D.WidthType.PERCENTAGE } : undefined,
    shading: head ? { type: D.ShadingType.CLEAR, fill: "141056", color: "auto" } : undefined,
    children: [new D.Paragraph({ children: [new D.TextRun({ text: text(t), bold: head, size: 17, color: head ? "FFFFFF" : "111111" })] })],
  });
  const w = Math.floor(100 / o.columns.length);
  const kids = [
    new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, children: [new D.TextRun({ text: o.title, bold: true })] }),
    new D.Paragraph({ children: [new D.TextRun({ text: "Atendar · Classroom Attendance", color: "555555" })] }),
    new D.Paragraph({ children: [new D.TextRun({ text: `Generated ${stamp()}`, color: "555555", size: 18 })], spacing: { after: 160 } }),
  ];
  if (o.subtitle) kids.push(new D.Paragraph({ children: [new D.TextRun({ text: o.subtitle })], spacing: { after: 160 } }));
  (o.summary || []).forEach(([k, v]) => kids.push(new D.Paragraph({ children: [new D.TextRun({ text: `${k}: `, bold: true }), new D.TextRun({ text: text(v) })] })));
  kids.push(new D.Paragraph({ text: "", spacing: { after: 120 } }));
  kids.push(new D.Table({
    width: { size: 100, type: D.WidthType.PERCENTAGE },
    rows: [new D.TableRow({ tableHeader: true, children: o.columns.map((c) => cell(c.label, { head: true, w })) }),
      ...o.rows.map((r) => new D.TableRow({ children: o.columns.map((c) => cell(r[c.key], { w })) }))],
  }));
  if (!o.rows.length) kids.push(new D.Paragraph({ children: [new D.TextRun({ text: "No records match the selected filters.", italics: true })] }));
  kids.push(new D.Paragraph({ children: [new D.TextRun({ text: "Powered by Ibratechh · https://ibratechh.com", size: 16, color: "777777" })], spacing: { before: 240 } }));
  const doc = new D.Document({ creator: "Atendar", title: o.title, sections: [{ children: kids }] });
  download(await D.Packer.toBlob(doc), `${name}.docx`);
}
