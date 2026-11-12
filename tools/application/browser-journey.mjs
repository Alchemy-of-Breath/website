// Local browser fixture only: install the strict local proxy and pixel test double
// described in README before passing this function to playwright-cli run-code.
async page => {
  for (const variant of ['coaches','default']) {
    const q=new URLSearchParams({utm_source:'facebook',utm_medium:'ppc',utm_id:'120254405385540483',utm_term:'120254405387700483'});
    if(variant==='coaches')q.set('for','coaches');
    await page.goto('https://website-5h3.pages.dev/facilitator-application/?'+q);
    await page.getByRole('button',{name:'Begin',exact:true}).click();
    for(let step=0;step<25;step++) {
      const current=page.getByRole('region');await current.waitFor({state:'visible'});
      const title=await current.getByRole('heading').innerText();
      const region=page.getByRole('region',{name:title,exact:true});
      const label=title.toLowerCase();
      const radios=region.getByRole('radio');
      let terminal=false;
      if(await radios.count()) {
        const yes=region.getByRole('radio',{name:'Yes',exact:true});
        if(await yes.count())await yes.click();else await radios.first().click();
      } else {
        const box=region.getByRole('textbox');
        const value=label==='first name'?'Synthetic':label==='last name'?'Qualified '+variant:label==='email'?'synthetic.qualified.'+variant+'@example.invalid':label.includes('phone')?'+44 7700 900123':label.includes('charging')?'100':'This is a synthetic local test answer for application reconciliation.';
        await box.fill(value);
        const submit=region.getByRole('button',{name:'Submit',exact:true});
        terminal=await submit.count()>0;
        await (terminal?submit:region.getByRole('button',{name:'OK',exact:true})).click();
      }
      if(terminal){await page.getByText('Application received · Step 2 of 2',{exact:true}).waitFor({state:'visible',timeout:15000});break;}
      await region.waitFor({state:'hidden'});
      if(await page.getByText('Application received · Step 2 of 2',{exact:true}).count())break;
      if(step===24)throw new Error('Journey did not reach its end');
    }
    const calls=await page.evaluate(()=>window.__pixelCalls.filter(x=>x[0]==='track'));
    if(calls.filter(x=>x[1]==='SubmitApplication').length!==1||calls.filter(x=>x[1]==='Lead').length!==1)throw new Error('Application and qualification events did not fire once for '+variant);
    if(calls[0][2].application_id!==calls[1][2].application_id||calls[0][3].eventID===calls[1][3].eventID)throw new Error('Event correlation failed');
    await page.screenshot({path:'output/playwright/'+variant+'-qualified.png'});
  }
}
