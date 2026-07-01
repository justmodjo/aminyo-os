# Correctif avatar.js — FROX Character Creator

## ✨ Changements clés

### 1. État initial tout à `null` — plus de layer par défaut

```js
let state = {
  genre: null,          // ← plus 'homme'
  morpho: null,         // ← plus 'athletic'
  carnation: null,      // ← plus 'clair1'
  yeux: null,           // ← plus 'marron'
  cheveux_style: null,
  cheveux_couleur: null,
  barbe: null,
  tenue_haut: null,
  tenue_bas: null,
  shoes: null,
  acc_tete: new Set(),
  acc_corps: new Set(),
  showDossard: false,
};
```

### 2. Garde-fou dans `_renderFrame()`

```js
ctx.fillStyle = '#0a0a0a';
ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
if (!state.genre) {
  ctx.restore();
  return; // ← canvas noir, rien d'autre
}
```

### 3. Chaque layer a sa condition `if (state.xxx)` avant de dessiner

Plus aucun dessin si la valeur est null.

### 4. `drawDossard()` ne fait plus de `clearRect()` destructeur

Transition en douceur, pas d'effacement sauvage.

---

## 🔧 Instructions

1. J'ai préparé le fichier `avatar.js` corrigé complet dans le workspace
2. Il fait 41KB — trop gros pour un message Telegram
3. Je te le découpe ci-dessous en **3 parties** à coller bout à bout

---

## 📄 Partie 1/3 — Assets + Constantes + State + Preload

```javascript
/* ===== ASSET PATHS (Cloudinary CDN) ===== */
const A = {
  corps: {
    homme: {
      lean: {
        clair1: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_lean_clair1_ld7hjt.png",
        clair2: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_lean_clair2_mvvtix.png",
        medium: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_lean_medium_xx4imo.png",
        mat: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_lean_mat_xohuoz.png",
        fonce: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_lean_fonce_s4z2do.png",
        ebene: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_lean_ebene_ma4jrc.png",
      },
      athletic: {
        clair1: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_athletic_clair1_z3pito.png",
        clair2: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_athletic_clair2_z65svs.png",
        medium: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_athletic_medium_bwpfld.png",
        mat: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_athletic_mat_in6gpe.png",
        fonce: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_athletic_fonce_cbnfnu.png",
        ebene: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_athletic_ebene_o7cogk.png",
      },
      power: {
        clair1: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_power_clair1_eu7dex.png",
        clair2: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_power_clair2_accj59.png",
        medium: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_power_medium_jkbqea.png",
        mat: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_power_mat_zj5kok.png",
        fonce: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_power_fonce_ajdxh9.png",
        ebene: "https://res.cloudinary.com/dsbgqfcd3/image/upload/homme_power_ebene_jduzio.png",
      },
    },
    femme: {
      lean: {
        clair1: "https://res.cloudinary.com/dsbgqfcd3/image/upload/femme_lean_clair1_dqeonw.png",
        clair2: "https://res.cloudinary.com/dsbgqfcd3/image/upload/femme_lean_clair2_yuvleu.png",
        medium: "https://res.cloudinary.com/dsbgqfcd3/image/upload/femme_lean_medium_cbamgv.png",
        mat: "https://res.cloudinary.com/dsbgqfcd3/image/upload/femme_lean_mat_vv58si.png",
        fonce: "https://res.cloudinary.com/dsbgqfcd3/image/upload/femme_lean_fonce_ahxvqc.png",
        ebene: "https://res.cloudinary.com/dsbgqfcd3/image/upload/femme_lean_ebene_nbyygg.png",
      },
      athletic: {
        clair1: "https://res.cloudinary.com/dsbgqfcd3/image/upload/femme_athletic_clair1_hqoxyn.png",
        clair2: "https://res.cloudinary.com/dsbgqfcd3/image/upload/femme_athletic_clair2_lsfnp5.png",
        medium: "https://res.cloudinary.com/dsbgqfcd3/image/upload/femme_athletic_medium_krgte8.png",
        mat: "https://res.cloudinary.com/dsbgqfcd3/image/upload/femme_athletic_mat_gltymg.png",
        fonce: "https://res.cloudinary.com/dsbgqfcd3/image/upload/femme_athletic_fonce_zum095.png",
        ebene: "https://res.cloudinary.com/dsbgqfcd3/image/upload/femme_athletic_ebene_jeokt7.png",
      },
    },
  },
  yeux: {
    homme: {
      marron: "https://res.cloudinary.com/dsbgqfcd3/image/upload/yeux_marron_djzpin.png",
      noisette: "https://res.cloudinary.com/dsbgqfcd3/image/upload/yeux_noisette_bonv8k.png",
      verts: "https://res.cloudinary.com/dsbgqfcd3/image/upload/yeux_verts_pwosf2.png",
      bleus: "https://res.cloudinary.com/dsbgqfcd3/image/upload/yeux_bleus_y4sifi.png",
    },
    femme: {
      marron: "https://res.cloudinary.com/dsbgqfcd3/image/upload/f_yeux_marron_tshwls.png",
      noisette: "https://res.cloudinary.com/dsbgqfcd3/image/upload/f_yeux_noisette_1_nwmxj8.png",
      verts: "https://res.cloudinary.com/dsbgqfcd3/image/upload/f_yeux_verts_mbmiyi.png",
      bleus: "https://res.cloudinary.com/dsbgqfcd3/image/upload/f_yeux_bleus_sebnie.png",
    },
  },
  cheveux_h: {
    courts: c => { const U = { noir:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_courts_noir_c6uvvx.png", brun:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_courts_brun_ioapjc.png", chatain:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_courts_chatain_bmrc3g.png", blond:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_courts_blond_s6wnat.png", roux:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_courts_roux_nuqoop.png", gris:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_courts_gris_hfodq9.png" }; return U[c] || U.noir; },
    rase: c => { const U = { noir:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_rase_noir_pp9rcj.png", brun:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_rase_brun_ymszjd.png", chatain:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_rase_chatain_p0kuki.png", blond:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_rase_blond_ztiquv.png", roux:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_rase_roux_pzxfgc.png", gris:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_rase_gris_nveylc.png" }; return U[c] || U.noir; },
    degrade: c => { const U = { noir:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_degrade_noir_afl1xo.png", brun:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_degrade_brun_fgbayf.png", chatain:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_degrade_chatain_t8jame.png", blond:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_degrade_blond_wykwih.png", roux:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_degrade_roux_s9m0vp.png", gris:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_degrade_gris_qdxfie.png" }; return U[c] || U.noir; },
    milongs: c => { const U = { noir:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_milongs_noir_vxdko3.png", brun:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_milongs_brun_r3uupm.png", chatain:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_milongs_chatain_uenuum.png", blond:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_milongs_blond_yucc1x.png", gris:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_milongs_gris_uqugz6.png" }; return U[c] || U.noir; },
    dreads: c => { const U = { noir:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_dreads_noir_hg3mp3.png", roux:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_dreads_roux_qnqc36.png", gris:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_dreads_gris_bika2a.png" }; return U[c] || U.noir; },
    afro: c => { const U = { noir:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_afro_noir_dsej9h.png", brun:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_afro_brun_n3xhzo.png", chatain:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_afro_chatain_ecy5gg.png", blond:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_afro_blond_tidn9h.png", roux:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_afro_roux_lo82tu.png", gris:"https://res.cloudinary.com/dsbgqfcd3/image/upload/h_cheveux_afro_gris_nmvnca.png" }; return U[c] || U.noir; },
  },
  cheveux_f: {
    longs: c => { const U = { noir:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_longs_noir_un31kp.png", brun:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_longs_brun_pqmbzx.png", chatain:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_longs_chatain_spa0xc.png", blond:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_longs_blond_emd7vk.png", roux:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_longs_roux_sagvf2.png", gris:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_longs_gris_idaxdg.png" }; return U[c] || U.noir; },
    pixie: c => { const U = { noir:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_pixie_noir_ppsrom.png", brun:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_pixie_brun_yu32pa.png", chatain:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_pixie_chatain_yutlgy.png", blond:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_pixie_blond_bnbmpa.png", roux:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_pixie_roux_kigh3b.png", gris:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_pixie_gris_bsq7br.png" }; return U[c] || U.noir; },
    bob: c => { const U = { noir:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_bob_noir_hnzupf.png", brun:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_bob_brun_gfxeqy.png", chatain:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_bob_chatain_ab3mxh.png", blond:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_bob_blond_baa206.png", roux:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_bob_roux_m9daod.png", gris:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_bob_gris_kpippq.png" }; return U[c] || U.noir; },
    ponytail: c => { const U = { noir:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_ponytail_noir_p3tukk.png", chatain:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_ponytail_chatain_g8zsed.png", blond:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_ponytail_blond_aw2tn5.png", gris:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_ponytail_gris_e6jozv.png" }; return U[c] || U.noir; },
    tresses: c => { const U = { noir:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_tresses_noir_zzu4ho.png", brun:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_tresses_brun_mc3xlc.png", chatain:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_tresses_chatain_ek5edp.png", blond:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_tresses_blond_zrieuk.png", roux:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_tresses_roux_xeztuf.png", gris:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_tresses_gris_wmyysc.png" }; return U[c] || U.noir; },
    chignon: c => { const U = { noir:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_chignon_noir_vhrj3s.png", brun:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_chignon_brun_jlid2o.png", chatain:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_chignon_chatain_evf4au.png", gris:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_chignon_gris_zc3x4n.png" }; return U[c] || U.noir; },
    rase: c => { const U = { noir:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_rase_noir_a9n7md.png", chatain:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_rase_chatain_lpiddg.png", roux:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_rase_roux_iijx5t.png", gris:"https://res.cloudinary.com/dsbgqfcd3/image/upload/f_cheveux_rase_gris_vper5f.png" }; return U[c] || U.noir; },
    afro: () => null,
  },
  barbe: {
    rase: "https://res.cloudinary.com/dsbgqfcd3/image/upload/h_barbe_rase_k3rcmv.png",
    courte: "https://res.cloudinary.com/dsbgqfcd3/image/upload/h_barbe_courte_uhrnlc.png",
    complete_courte: "https://res.cloudinary.com/dsbgqfcd3/image/upload/h_barbe_complete_courte_lnn2ce.png",
    complete_longue: "https://res.cloudinary.com/dsbgqfcd3/image/upload/h_barbe_complete_longue_tpr9fx.png",
    moustache: "https://res.cloudinary.com/dsbgqfcd3/image/upload/h_barbe_moustache_sfxtr0.png",
    bouc1: "https://res.cloudinary.com/dsbgqfcd3/image/upload/h_barbe_bouc1_uvwubp.png",
    bouc2: "https://res.cloudinary.com/dsbgqfcd3/image/upload/h_barbe_bouc2_vqncrf.png",
  },
  tenue_haut_h: {
    full_black: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_haut_full_black_kmmr5c.png",
    blanc_noir: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_haut_blanc_noir_zjwjai.png",
    gris_rouge: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_haut_gris_rouge_frombh.png",
    navy_blanc: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_haut_navy_blanc_taq24y.png",
    noir_jaune: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_f_haut_noir_jaune_hbhz0t.png",
  },
  tenue_bas_h: {
    noir: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_bas_noir_wr8kba.png",
    blanc: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_bas_blanc_iesfqz.png",
    gris: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_bas_gris_m6feut.png",
    navy: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_bas_navy_uwzyip.png",
    rouge: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_bas_rouge_wr7flj.png",
  },
  tenue_haut_f: {
    full_black: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_f_haut_full_black_c9ague.png",
    blanc_noir: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_f_haut_blanc_noir_r09wb6.png",
    gris_rouge: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_f_haut_gris_rouge_ntrq9n.png",
    navy_blanc: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_f_haut_navy_blanc_jmzrud.png",
    noir_jaune: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_f_haut_noir_jaune_hbhz0t.png",
  },
  tenue_bas_f: {
    noir: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_f_bas_noir_eiqkfb.png",
    blanc: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_f_bas_blanc_t9y0gb.png",
    gris: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_f_bas_gris_vusuyu.png",
    navy: "https://res.cloudinary.com/dsbgqfcd3/image/upload/tenue_f_bas_navy_j0ahn8.png",
  },
  shoes_h: {
    nike_metcon: "https://res.cloudinary.com/dsbgqfcd3/image/upload/shoes_f_nike_metcon_w4vztc.png",
    adidas_ultraboost: "https://res.cloudinary.com/dsbgqfcd3/image/upload/shoes_f_adidas_ultraboost_qyhhsu.png",
    nobull: "https://res.cloudinary.com/dsbgqfcd3/image/upload/shoes_f_nobull_ekz2vj.png",
    on_running: "https://res.cloudinary.com/dsbgqfcd3/image/upload/shoes_f_on_running_socmn9.png",
  },
  shoes_f: {
    nike_metcon: "https://res.cloudinary.com/dsbgqfcd3/image/upload/shoes_f_nike_metcon_w4vztc.png",
    adidas_ultraboost: "https://res.cloudinary.com/dsbgqfcd3/image/upload/shoes_f_adidas_ultraboost_qyhhsu.png",
    nobull: "https://res.cloudinary.com/dsbgqfcd3/image/upload/shoes_f_nobull_ekz2vj.png",
    on_running: "https://res.cloudinary.com/dsbgqfcd3/image/upload/shoes_f_on_running_socmn9.png",
  },
  acc_tete: {
    casquette: "https://res.cloudinary.com/dsbgqfcd3/image/upload/acc_tete_casquette_kjprzc.png",
    bandeau: "https://res.cloudinary.com/dsbgqfcd3/image/upload/acc_tete_bandeau_uxffnw.png",
    lunettes: "https://res.cloudinary.com/dsbgqfcd3/image/upload/acc_tete_lunettes_stm2vp.png",
  },
  acc_corps: {
    montre: "https://res.cloudinary.com/dsbgqfcd3/image/upload/acc_corps_montre_j0cww1.png",
    genouilleres: "https://res.cloudinary.com/dsbgqfcd3/image/upload/acc_corps_genouilleres_tiabpb.png",
    gants: "https://res.cloudinary.com/dsbgqfcd3/image/upload/acc_corps_gants_lu8ay0.png",
  },
  dossard: "https://res.cloudinary.com/dsbgqfcd3/image/upload/dossard_hyrox_nfu1g7.png",
};

const MORPHO_SCALE = {
  lean:     { sx: 0.88, sy: 1.0,  tx: 0.06, ty: 0 },
  athletic: { sx: 1.0,  sy: 1.0,  tx: 0,    ty: 0 },
  power:    { sx: 1.15, sy: 1.05, tx: -0.075, ty: 0 },
};

const PROGRAMMES = {
  lean:     { nom: 'Programme Endurance', badge: 'RUNNER', vibe: "T'es fait pour voler. On va te faire voler encore plus vite.", seances: '4x/semaine', duree: '12 semaines' },
  athletic: { nom: 'Programme Complet',   badge: 'ALL-IN',  vibe: "Le bon mix. C'est exactement ça, Hyrox.", seances: '4x/semaine', duree: '10 semaines' },
  power:    { nom: 'Programme Force',     badge: 'BEAST',   vibe: "T'as la base. On va tout canaliser.", seances: '3x/semaine', duree: '12 semaines' },
};

let state = {
  prenom: '',
  programme: 'athletic',
  genre: null, morpho: null, carnation: null, yeux: null,
  cheveux_style: null, cheveux_couleur: null, barbe: null,
  tenue_haut: null, tenue_bas: null, shoes: null,
  acc_tete: new Set(), acc_corps: new Set(),
  showDossard: false,
};

const CANVAS_W = 768;
const CANVAS_H = 1024;
let canvas, ctx, imageCache = {};

function getAllPaths() {
  const paths = new Set();
  const carnations = ['clair1','clair2','medium','mat','fonce','ebene'];
  const couleurs = ['noir','brun','chatain','blond','roux','gris'];
  carnations.forEach(c => {
    ['lean','athletic','power'].forEach(m => paths.add(A.corps.homme[m][c]));
    ['lean','athletic'].forEach(m => paths.add(A.corps.femme[m][c]));
  });
  ['homme','femme'].forEach(g => Object.values(A.yeux[g]).forEach(p => paths.add(p)));
  couleurs.forEach(c => {
    Object.values(A.cheveux_h).forEach(fn => { const p = fn(c); if(p) paths.add(p); });
    Object.values(A.cheveux_f).forEach(fn => { const p = fn(c); if(p) paths.add(p); });
  });
  Object.values(A.barbe).forEach(p => paths.add(p));
  Object.values(A.tenue_haut_h).forEach(p => paths.add(p));
  Object.values(A.tenue_bas_h).forEach(p => paths.add(p));
  Object.values(A.tenue_haut_f).forEach(p => paths.add(p));
  Object.values(A.tenue_bas_f).forEach(p => paths.add(p));
  Object.values(A.shoes_h).forEach(p => paths.add(p));
  Object.values(A.shoes_f).forEach(p => paths.add(p));
  Object.values(A.acc_tete).forEach(p => paths.add(p));
  Object.values(A.acc_corps).forEach(p => paths.add(p));
  paths.add(A.dossard);
  return Array.from(paths).filter(p => typeof p === 'string' && p.length > 0);
}

async function preloadImages(onProgress) {
  const paths = getAllPaths();
  const total = paths.length;
  let loaded = 0;
  await Promise.all(paths.map(path => new Promise(resolve => {
    if (imageCache[path]) { loaded++; onProgress?.(loaded / total); resolve(); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { imageCache[path] = img; loaded++; onProgress?.(loaded / total); resolve(); };
    img.onerror = () => { loaded++; onProgress?.(loaded / total); resolve(); };
    img.src = path;
  })));
}
```
