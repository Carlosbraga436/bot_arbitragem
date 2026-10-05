import { fetchCexDepth } from './cex-depth.js';
import { DEFAULT_RULES, evaluateRoute, exchangeFeePct } from './core.js';

export const REALITY_GATE_DEFAULTS = Object.freeze({
  depthLimit:100,
  requiredStreak:3,
  confirmationTtlMs:6_000,
  persistenceGapMs:5_000,
  minCheckIntervalMs:1_600,
  maxCandidates:7,
  maxConcurrent:4,
});

export function realityRouteKey(route, budgetUsdt) {
  return [
    Number(budgetUsdt)||0,
    String(route?.symbol||''),
    String(route?.buyExchange||''),
    String(route?.sellExchange||''),
  ].join('|');
}

export function realityConfidenceScore({
  streak=0,
  requiredStreak=3,
  ageMs=Infinity,
  skewMs=Infinity,
  executionSharePct=0,
  depthConfirmed=false,
}={}) {
  let score=0;
  if (depthConfirmed) score+=45;
  score+=Math.min(25,(Math.max(0,Number(streak)||0)/Math.max(1,Number(requiredStreak)||3))*25);
  if (Number(ageMs)<=1_000) score+=10;
  else if (Number(ageMs)<=2_500) score+=6;
  if (Number(skewMs)<=750) score+=10;
  else if (Number(skewMs)<=2_000) score+=6;
  score+=Math.min(10,Math.max(0,Number(executionSharePct)||0)/10);
  return Math.max(0,Math.min(100,Math.round(score)));
}

function attachEconomics(result,costs) {
  if (!result?.buyExchange || !result?.sellExchange || !Number.isFinite(result?.netPnlUsdt)) return result;
  const breakEvenPct=
    exchangeFeePct(result.buyExchange,costs)
    + exchangeFeePct(result.sellExchange,costs)
    + (Number(costs?.reservePct)||0)*2;
  const budget=Number(result?.budgetUsdt);
  const recomposition=Number(costs?.recompositionUsdt)||0;
  return {
    ...result,
    breakEvenPct,
    breakEvenAfterRebalancePct:Number.isFinite(budget)&&budget>0
      ? breakEvenPct+(recomposition/budget)*100
      : null,
  };
}

export function createRealityGate({
  fetchDepth=fetchCexDepth,
  now=()=>Date.now(),
  config={},
}={}) {
  const cfg={...REALITY_GATE_DEFAULTS,...config};
  const states=new Map();
  const inflight=new Map();

  function activeState(route,budgetUsdt) {
    return states.get(realityRouteKey(route,budgetUsdt))||null;
  }

  async function check(route,{asset,budgetUsdt,costs}) {
    const key=realityRouteKey(route,budgetUsdt);
    if (inflight.has(key)) return inflight.get(key);

    const current=states.get(key);
    const checkNow=now();
    if (current?.lastAttemptAt && checkNow-current.lastAttemptAt<cfg.minCheckIntervalMs) {
      return current;
    }

    const task=(async()=>{
      const startedAt=now();
      states.set(key,{
        ...(current||{}),
        key,
        symbol:route.symbol,
        buyExchange:route.buyExchange,
        sellExchange:route.sellExchange,
        budgetUsdt,
        lastAttemptAt:startedAt,
        status:'checking',
      });

      try {
        const [buyBook,sellBook]=await Promise.all([
          fetchDepth(route.buyExchange,route.symbol,cfg.depthLimit),
          fetchDepth(route.sellExchange,route.symbol,cfg.depthLimit),
        ]);
        const evaluatedAt=now();
        const evaluated=attachEconomics(evaluateRoute({
          symbol:route.symbol,
          identityConfirmed:Boolean(asset?.identityConfirmed),
          buyExchange:route.buyExchange,
          sellExchange:route.sellExchange,
          buyBook,
          sellBook,
          budgetUsdt,
          costs,
          rules:DEFAULT_RULES,
          now:evaluatedAt,
        }),costs);

        const positive=Boolean(evaluated?.eligible)&&Number(evaluated?.netPnlUsdt)>0;
        const previousSuccess=Number(current?.lastSuccessAt)||0;
        const persisted=previousSuccess>0 && evaluatedAt-previousSuccess<=cfg.persistenceGapMs;
        const streak=positive ? (persisted?(Number(current?.streak)||0)+1:1) : 0;
        const confirmed=positive && streak>=cfg.requiredStreak;
        const depthAgeMs=Math.max(
          Math.max(0,evaluatedAt-Number(buyBook?.ts||evaluatedAt)),
          Math.max(0,evaluatedAt-Number(sellBook?.ts||evaluatedAt)),
        );
        const depthSkewMs=Math.abs(Number(buyBook?.ts||evaluatedAt)-Number(sellBook?.ts||evaluatedAt));
        const confidenceScore=realityConfidenceScore({
          streak,
          requiredStreak:cfg.requiredStreak,
          ageMs:depthAgeMs,
          skewMs:depthSkewMs,
          executionSharePct:evaluated?.executionSharePct,
          depthConfirmed:positive,
        });

        const next={
          key,
          symbol:route.symbol,
          buyExchange:route.buyExchange,
          sellExchange:route.sellExchange,
          budgetUsdt,
          status:confirmed?'confirmed':(positive?'confirming':'rejected'),
          confirmed,
          depthConfirmed:positive,
          confirmationStreak:streak,
          confirmationsRequired:cfg.requiredStreak,
          confidenceScore,
          lastAttemptAt:startedAt,
          lastSuccessAt:positive?evaluatedAt:(current?.lastSuccessAt||null),
          confirmedAt:confirmed?(current?.confirmedAt||evaluatedAt):null,
          depthAgeMs,
          depthSkewMs,
          buyDepthLevels:Array.isArray(buyBook?.asks)?buyBook.asks.length:0,
          sellDepthLevels:Array.isArray(sellBook?.bids)?sellBook.bids.length:0,
          buyDepthSource:buyBook?.source||null,
          sellDepthSource:sellBook?.source||null,
          orderRulesVerified:false,
          executionMode:'prepositioned_inventory',
          transferabilityVerified:false,
          result:evaluated,
          error:null,
        };
        states.set(key,next);
        return next;
      } catch(error) {
        const failedAt=now();
        const next={
          ...(states.get(key)||current||{}),
          key,
          symbol:route.symbol,
          buyExchange:route.buyExchange,
          sellExchange:route.sellExchange,
          budgetUsdt,
          status:'error',
          confirmed:false,
          depthConfirmed:false,
          confirmationStreak:0,
          confirmationsRequired:cfg.requiredStreak,
          lastAttemptAt:startedAt,
          failedAt,
          confidenceScore:0,
          orderRulesVerified:false,
          executionMode:'prepositioned_inventory',
          transferabilityVerified:false,
          error:error?.message||String(error),
        };
        states.set(key,next);
        return next;
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key,task);
    return task;
  }

  function kick(candidates,{budgetUsdt,contextForRoute}) {
    const rows=(Array.isArray(candidates)?candidates:[])
      .filter((r)=>r?.eligible&&r?.symbol&&r?.buyExchange&&r?.sellExchange)
      .slice(0,cfg.maxCandidates);

    const eligible=rows.filter((route)=>{
      const state=activeState(route,budgetUsdt);
      return !state?.lastAttemptAt || now()-state.lastAttemptAt>=cfg.minCheckIntervalMs;
    }).slice(0,cfg.maxConcurrent);

    for (const route of eligible) {
      const context=contextForRoute(route)||{};
      check(route,{...context,budgetUsdt}).catch(()=>{});
    }
  }

  function confirmed(candidates,budgetUsdt) {
    const currentKeys=new Set((candidates||[]).map((r)=>realityRouteKey(r,budgetUsdt)));
    const nowMs=now();
    const rows=[];
    for (const route of candidates||[]) {
      const key=realityRouteKey(route,budgetUsdt);
      const state=states.get(key);
      if (!state?.confirmed || !state?.result?.eligible) continue;
      if (!currentKeys.has(key)) continue;
      if (!state.lastSuccessAt || nowMs-state.lastSuccessAt>cfg.confirmationTtlMs) continue;
      rows.push({
        ...state.result,
        venueQuotes:route.venueQuotes,
        realityStatus:'confirmed',
        depthConfirmed:true,
        confirmationStreak:state.confirmationStreak,
        confirmationsRequired:state.confirmationsRequired,
        confidenceScore:state.confidenceScore,
        depthAgeMs:state.depthAgeMs,
        depthSkewMs:state.depthSkewMs,
        buyDepthLevels:state.buyDepthLevels,
        sellDepthLevels:state.sellDepthLevels,
        orderRulesVerified:false,
        executionMode:'prepositioned_inventory',
        transferabilityVerified:false,
        realityCheckedAt:state.lastSuccessAt,
      });
    }
    return rows
      .sort((a,b)=>(b.netPnlUsdt??-Infinity)-(a.netPnlUsdt??-Infinity))
      .slice(0,5);
  }

  function signals(candidates,budgetUsdt) {
    return (candidates||[]).slice(0,5).map((route)=>{
      const state=activeState(route,budgetUsdt);
      return {
        ...route,
        realityStatus:state?.status||'queued',
        depthConfirmed:Boolean(state?.depthConfirmed),
        confirmationStreak:Number(state?.confirmationStreak)||0,
        confirmationsRequired:cfg.requiredStreak,
        confidenceScore:Number(state?.confidenceScore)||0,
        orderRulesVerified:false,
        executionMode:'prepositioned_inventory',
        transferabilityVerified:false,
        realityCheckedAt:state?.lastSuccessAt||null,
      };
    });
  }

  function stats(candidates,budgetUsdt) {
    const rows=(candidates||[]).slice(0,cfg.maxCandidates);
    const stateRows=rows.map((r)=>activeState(r,budgetUsdt)).filter(Boolean);
    return {
      candidateCount:rows.length,
      checking:stateRows.filter((s)=>s.status==='checking').length,
      confirming:stateRows.filter((s)=>s.status==='confirming').length,
      confirmed:confirmed(candidates,budgetUsdt).length,
      errors:stateRows.filter((s)=>s.status==='error').length,
      requiredStreak:cfg.requiredStreak,
      confirmationTtlMs:cfg.confirmationTtlMs,
      depthLimit:cfg.depthLimit,
    };
  }

  return {kick,check,confirmed,signals,stats,activeState};
}
