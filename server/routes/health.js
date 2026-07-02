const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'cliniqboost-ai',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

router.get('/db', async (req, res) => {
  try {
    const { data } = await supabase.from('clinics').select('count').single();
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', database: err.message });
  }
});

module.exports = router;
