import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import xlsx from "xlsx";

const OUT_PATH = path.join("data","data.json");
const TMP_XLSX = "tmp_sheet.xlsx";

const SHEET_URL = process.env.GOOGLE_SHEETS_XLSX_URL;
if(!SHEET_URL){
  console.error("Falta GOOGLE_SHEETS_XLSX_URL (Settings -> Secrets and variables -> Actions -> Variables).");
  process.exit(1);
}

function withDownload(u){
  // Garante export XLSX
  const url = String(u);
  if(url.includes("export?format=xlsx")) return url;
  const m = url.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if(!m) return url;
  const id = m[1];
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;
}

async function download(url, dest){
  const res = await fetch(url, { redirect: "follow" });
  if(!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(`Falha ao baixar XLSX (${res.status}) ${txt.slice(0,200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

function uniqHeaders(headers){
  const seen = new Map();
  return headers.map((h)=>{
    let name = String(h ?? "").trim();
    if(!name) name = "EMPTY";
    // normaliza espaços
    name = name.replace(/\s+/g," ").trim();
    const count = seen.get(name) ?? 0;
    seen.set(name, count+1);
    return count===0 ? name : `${name}_${count}`;
  });
}

function toNum(v){
  if(v===null||v===undefined||v==="") return NaN;
  if(typeof v==="number") return v;
  const s = String(v).trim();
  if(!s) return NaN;
  const cleaned = s.replace(/[R$\s]/g,"").replace(/\./g,"").replace(",",".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

const MONTHS_PT = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const isMonth = (v)=> MONTHS_PT.includes(String(v||"").trim());

function buildLegacy(rows, metaUpdatedAt){
  // pega 1 linha por mês
  const byMonth = new Map();
  for(const r of rows){
    let m = "";
    const candidates = [r["Mês"], r["Mes"], r["Dashboard"], r["Competência"], r["Competencia"], r["Período"], r["Periodo"], r["Nubank"], r["Santander"]];
    for(const c of candidates){
      if(isMonth(c)){ m = String(c).trim(); break; }
    }
    if(!m){
      for(const v of Object.values(r)){
        if(isMonth(v)){ m = String(v).trim(); break; }
      }
    }
    if(m && !byMonth.has(m)) byMonth.set(m, r);
  }
  const months = Array.from(byMonth.keys()).sort((a,b)=>MONTHS_PT.indexOf(a)-MONTHS_PT.indexOf(b));

  const legacyMonths = months.map((name)=>{
    const row = byMonth.get(name) || {};
    const mi = MONTHS_PT.indexOf(name) + 1;
    const key = `2026-${String(mi).padStart(2,"0")}`;

    const entrada = toNum(row["Entrada"] ?? row["ENTRADA"]);
    const saida = toNum(row["Saída"] ?? row["Saida"] ?? row["Saída "]);
    const liquido = toNum(row["Líquido"] ?? row["Liquido"]);
    const diff_m1 = toNum(row["Diferença M-1"] ?? row["Diferenca M-1"] ?? row["Diferença"] ?? row["Diferenca"]);
    const crescimento = toNum(row["Crescimento"] ?? row["Crescimento %"] ?? row["Crescimento%"]);

    const nubank_saida = toNum(row["Saída_1"] ?? row["Saida_1"] ?? row["Nubank Saída"] ?? row["Nubank_saida"]);
    const santander_saida = toNum(row["Saída_2"] ?? row["Saida_2"] ?? row["Santander Saída"] ?? row["Santander_saida"]);

    const e = Number.isFinite(entrada) ? entrada : 0;
    const s = Number.isFinite(saida) ? saida : 0;
    const l = Number.isFinite(liquido) ? liquido : (e - s);

    return {
      name,
      month: mi,
      key,
      summary: {
        entrada: e,
        saida: s,
        liquido: l,
        diff_m1: Number.isFinite(diff_m1) ? diff_m1 : 0,
        crescimento: Number.isFinite(crescimento) ? crescimento : null
      },
      accounts: {
        nubank_saida: Number.isFinite(nubank_saida) ? nubank_saida : 0,
        santander_saida: Number.isFinite(santander_saida) ? santander_saida : 0
      },
      details: { entradas: [], saidas: [] }
    };
  });

  const totals = legacyMonths.reduce((acc,m)=>{
    acc.entrada += Number(m.summary?.entrada||0);
    acc.saida += Number(m.summary?.saida||0);
    acc.liquido += Number(m.summary?.liquido||0);
    return acc;
  }, { entrada:0, saida:0, liquido:0 });

  return {
    version: 1,
    year: 2026,
    months: legacyMonths,
    generatedAt: metaUpdatedAt || new Date().toISOString(),
    totals
  };
}

async function main(){
  const url = withDownload(SHEET_URL);
  console.log("Baixando:", url);
  await download(url, TMP_XLSX);

  const wb = xlsx.readFile(TMP_XLSX, { cellDates:true });
  const first = wb.SheetNames[0];
  if(!first) throw new Error("Nenhuma aba encontrada.");

  const sh = wb.Sheets[first];
  const grid = xlsx.utils.sheet_to_json(sh, { header: 1, raw: true, defval: "" });
  if(!grid.length) throw new Error("Planilha vazia.");

  const headers = uniqHeaders(grid[0]);
  const outRows = [];

  for(let i=1;i<grid.length;i++){
    const rowArr = grid[i] || [];
    const obj = {};
    let any = false;
    for(let c=0;c<headers.length;c++){
      const v = rowArr[c] ?? "";
      obj[headers[c]] = v;
      if(String(v).trim()!=="") any = true;
    }
    if(any) outRows.push(obj);
  }

  const metaUpdatedAt = new Date().toISOString();
  const legacy = buildLegacy(outRows, metaUpdatedAt);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive:true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(legacy, null, 2), "utf-8");

  console.log("Gerado:", OUT_PATH, "meses:", legacy.months.length);
}

main().catch((e)=>{
  console.error(e);
  process.exit(1);
});
