(async ()=>{
  try{
    // Require the reports router to access its attached generators
    const reportsRouter = require('../routes/reports');
    const fs = require('fs').promises;
    const path = require('path');

    const startDate = new Date('2026-05-01T00:00:00.000Z');
    const endDate = new Date('2026-05-31T23:59:59.999Z');

    const outDir = path.join(__dirname, '..', 'report_outputs');
    await fs.mkdir(outDir, { recursive: true });

    const types = ['sales','products','inventory','user-activity','categories','tax'];

    for(const t of types){
      console.log('Generating', t);
      const data = await reportsRouter['generate' + (
        t === 'user-activity' ? 'UserActivity' : (t === 'user-activity' ? 'UserActivity' : t.charAt(0).toUpperCase() + t.slice(1))
      ) + 'Report'](startDate, endDate, null, {});

      const workbook = await reportsRouter.createExcelReport(t, data, startDate, endDate);
      const fileName = `${t}_report_${startDate.toISOString().slice(0,10)}_${endDate.toISOString().slice(0,10)}.xlsx`;
      const outPath = path.join(outDir, fileName);
      await workbook.xlsx.writeFile(outPath);
      console.log('Written', outPath);
    }

    console.log('All reports generated');
    process.exit(0);
  }catch(e){
    console.error('generateReports error', e);
    process.exit(2);
  }
})();
