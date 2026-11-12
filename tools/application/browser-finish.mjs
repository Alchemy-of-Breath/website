// This function is passed to playwright-cli run-code only after a fresh snapshot.
// It drives visible controls and checks the rendered result. External traffic must
// already be routed to local-harness.mjs, with all other origins blocked.
async page => {
  await page.getByRole('textbox',{name:'Email',exact:true}).fill('synthetic.coaches@example.invalid');
  await page.getByRole('button',{name:'Submit',exact:true}).click();
  await page.getByText('Application received',{exact:false}).waitFor({state:'visible',timeout:15000});
  const pixel=await page.evaluate(()=>window.__pixelCalls.filter(x=>x[0]==='track'));
  console.log(JSON.stringify({end:await page.locator('main').innerText(),pixel}));
}
