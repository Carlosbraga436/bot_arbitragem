import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('CP26 mantém Top 5 visível e ticket interativo no shell mobile', async () => {
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const js=await readFile(new URL('../public/app.js',import.meta.url),'utf8');

  for (const id of ['top5Board','top5List','focusCard','systemHealth','dexModule']) {
    assert.match(html,new RegExp(`id=["']${id}["']`));
  }

  assert.match(js,/function renderTop5\(/);
  assert.match(js,/function renderFocusedOpportunity\(/);
  assert.match(js,/selectedRouteKey/);
  assert.match(js,/setInterval\([^]*fetchRadar[^]*1000\)/);
  assert.match(js,/data-route-key/);
});

test('CP26 deixa DEX secundário e carregado sob demanda', async () => {
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const js=await readFile(new URL('../public/app.js',import.meta.url),'utf8');

  assert.match(html,/<details id="dexModule"/);
  assert.match(js,/if\(state\.dexBusy\|\|!\$\('dexModule'\)\?\.open\) return/);
  assert.match(js,/addEventListener\('toggle'/);
});
