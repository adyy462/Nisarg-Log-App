import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Home, 
  PlusCircle, 
  List, 
  Settings as SettingsIcon, 
  Cloud, 
  CloudOff, 
  RefreshCw, 
  ArrowDown, 
  ArrowUp, 
  Trash, 
  Edit, 
  FileText, 
  ExternalLink, 
  Table, 
  ArrowLeft, 
  Check, 
  AlertTriangle, 
  User, 
  Shield, 
  Database, 
  Printer, 
  Sparkles, 
  X 
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  onAuthStateChanged, 
  signInAnonymously, 
  User as FirebaseUser 
} from 'firebase/auth';
import { 
  collection, 
  doc, 
  onSnapshot, 
  setDoc, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  query, 
  orderBy, 
  writeBatch,
  getDoc
} from 'firebase/firestore';
import { GoogleGenAI, Type } from "@google/genai";
import { auth, db, OperationType, handleFirestoreError } from './firebase';
import { Transaction, AppSettings, Session } from './types';

// --- Config ---
const VIEW_SHEET_URL = "https://docs.google.com/spreadsheets/d/1clGHk-Bl1GlNqKg7ciGDpY7FOdJimSA0DguXU0lW5gw/edit?usp=sharing";
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwZGBVq9RmUoWaU3ZqNdxh-H5od50WSyz4CTaQoTdi1RDiFkIKOSRwGvhZ98prNVEXltA/exec";

// --- Utils ---
const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('en-IN', { 
    style: 'currency', 
    currency: 'INR', 
    maximumFractionDigits: 0 
  }).format(amount || 0);
};

const formatDateMarathi = (dateStr: string) => {
  if (!dateStr) return '—';
  try {
    const dateObj = new Date(dateStr);
    if (isNaN(dateObj.getTime())) return String(dateStr);
    const days = ['रविवार', 'सोमवार', 'मंगळवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'];
    return `${String(dateObj.getDate()).padStart(2, '0')}/${String(dateObj.getMonth() + 1).padStart(2, '0')}/${dateObj.getFullYear()} (${days[dateObj.getDay()]})`;
  } catch (e) { return String(dateStr); }
};

const transliterateToMarathi = async (text: string) => {
  if (!text) return text;
  const words = text.split(' ');
  const translatedWords = await Promise.all(words.map(async (word) => {
    if (!word.trim() || !/[a-zA-Z]/.test(word)) return word;
    try {
      const res = await fetch(`https://inputtools.google.com/request?text=${word}&itc=mr-t-i0-und&num=1&cp=0&cs=1&ie=utf-8&oe=utf-8`);
      const data = await res.json();
      if (data[0] === 'SUCCESS') {
        return data[1][0][1][0];
      }
    } catch (e) {}
    return word;
  }));
  return translatedWords.join(' ');
};

// --- Components ---

interface ActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm?: () => void;
  title: string;
  message: string;
  type?: 'success' | 'confirm' | 'warning' | 'error';
}

function ActionModal({ isOpen, onClose, onConfirm, title, message, type = 'success' }: ActionModalProps) {
  if (!isOpen) return null;
  const isConfirm = type === 'confirm';
  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-slate-900/80 backdrop-blur-md animate-in">
      <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-sm p-8 text-center border border-slate-100">
        <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 ${
          type === 'success' ? 'bg-emerald-100 text-emerald-600' : 
          isConfirm ? 'bg-red-100 text-red-600' : 
          type === 'error' ? 'bg-red-100 text-red-600' :
          'bg-amber-100 text-amber-600'
        }`}>
          {type === 'success' ? <Check size={32} /> : isConfirm ? <Trash size={32} /> : <AlertTriangle size={32} />}
        </div>
        <h2 className="text-xl font-black text-slate-900 mb-2">{title}</h2>
        <div className="text-slate-500 font-bold mb-6 text-sm whitespace-pre-wrap">
          {message}
        </div>
        <div className="flex flex-col gap-2">
          {isConfirm ? (
            <>
              <button onClick={onConfirm} className="w-full bg-red-600 text-white py-3 rounded-xl font-black uppercase active:scale-95">हो, हटवा</button>
              <button onClick={onClose} className="w-full bg-slate-100 text-slate-600 py-3 rounded-xl font-black uppercase active:scale-95">रद्द करा</button>
            </>
          ) : (
            <button onClick={onClose} className="w-full bg-slate-900 text-white py-3 rounded-xl font-black uppercase active:scale-95">ठीक आहे</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [dbStatus, setDbStatus] = useState<'connecting' | 'connected' | 'offline' | 'error'>('connecting');
  const [activeTab, setActiveTab] = useState('dashboard');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [settings, setSettings] = useState<AppSettings>({
    departments: ['निसर्ग विलाज', 'जेसीबी', 'ट्रॅक्टर', 'क्रेन'],
    machineryTypes: ['जेसीबी', 'ट्रॅक्टर', 'क्रेन'],
    googleSheetUrl: SCRIPT_URL,
    enteredBy: '',
    openingBalanceConfig: { amount: 5200, date: '2026-04-01' }
  });
  
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editingEntry, setEditingEntry] = useState<Transaction | null>(null);
  const [isPulling, setIsPulling] = useState(false);
  const [txLoaded, setTxLoaded] = useState(false);
  const [modal, setModal] = useState<{ open: boolean; title: string; message: string; type: 'success' | 'confirm' | 'warning' | 'error' }>({ 
    open: false, title: '', message: '', type: 'success' 
  });
  
  const [expenseForm, setExpenseForm] = useState({ 
    date: new Date().toISOString().split('T')[0], 
    voucherNo: '', 
    particulars: '', 
    department: 'निसर्ग विलाज', 
    amount: '', 
    sessions: [{ hours: '', minutes: '' }] as Session[], 
    remarks: '' 
  });
  const [receiptForm, setReceiptForm] = useState({ 
    date: new Date().toISOString().split('T')[0], 
    receivedFrom: '', 
    amount: '', 
    remarks: '' 
  });

  const [aiQuery, setAiQuery] = useState('');
  const [aiResponse, setAiResponse] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [isAiOpen, setIsAiOpen] = useState(false);
  const [smartInput, setSmartInput] = useState('');
  const [isSmartLoading, setIsSmartLoading] = useState(false);
  const [insights, setInsights] = useState('');
  const [isInsightLoading, setIsInsightLoading] = useState(false);

  const ai = useMemo(() => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! }), []);

  // --- Auth & Data Listeners ---
  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        try {
          await signInAnonymously(auth);
        } catch (e) {
          setDbStatus('offline');
          setTxLoaded(true);
        }
      } else {
        setUser(u);
      }
    });
    return () => unsubAuth();
  }, []);

  useEffect(() => {
    if (!user) return;

    const settingsRef = doc(db, 'users', user.uid, 'settings', 'app');
    const unsubSettings = onSnapshot(settingsRef, (snap) => {
      if (snap.exists()) {
        setSettings(snap.data() as AppSettings);
      }
      setDbStatus('connected');
    }, (err) => {
      console.error("Settings listener error:", err);
      setDbStatus('error');
    });

    const txQuery = query(collection(db, 'users', user.uid, 'transactions'), orderBy('createdAt', 'desc'));
    const unsubTx = onSnapshot(txQuery, (snap) => {
      const txs = snap.docs.map(d => ({ id: d.id, ...d.data() } as Transaction));
      setTransactions(txs);
      setTxLoaded(true);
    }, (err) => {
      console.error("Transactions listener error:", err);
      setTxLoaded(true);
    });

    return () => {
      unsubSettings();
      unsubTx();
    };
  }, [user]);

  // --- Stats ---
  const stats = useMemo(() => {
    let rec = 0, spent = 0;
    transactions.forEach(t => {
      if (t.type === 'receipt') rec += Number(t.amount || 0);
      else spent += Number(t.amount || 0);
    });
    return {
      totalReceived: rec,
      totalSpent: spent,
      remainingAmount: (Number(settings.openingBalanceConfig.amount) || 0) + rec - spent
    };
  }, [transactions, settings.openingBalanceConfig.amount]);

  // --- Actions ---
  const handleSaveEntry = async (e: React.FormEvent, type: 'expense' | 'receipt') => {
    e.preventDefault();
    if (!user) return;

    let entryData: any;
    if (type === 'expense') {
      const totalMins = expenseForm.sessions.reduce((acc, s) => acc + (Number(s.hours) || 0) * 60 + (Number(s.minutes) || 0), 0);
      entryData = {
        ...expenseForm,
        type: 'expense',
        amount: Number(expenseForm.amount),
        hours: Math.floor(totalMins / 60),
        minutes: totalMins % 60,
        userId: user.uid,
        createdAt: editingEntry ? editingEntry.createdAt : Date.now(),
        enteredBy: settings.enteredBy
      };
    } else {
      entryData = {
        type: 'receipt',
        date: receiptForm.date,
        particulars: receiptForm.receivedFrom,
        receivedFrom: receiptForm.receivedFrom,
        amount: Number(receiptForm.amount),
        remarks: receiptForm.remarks,
        userId: user.uid,
        createdAt: editingEntry ? editingEntry.createdAt : Date.now(),
        enteredBy: settings.enteredBy
      };
    }

    try {
      if (editingEntry) {
        await updateDoc(doc(db, 'users', user.uid, 'transactions', editingEntry.id), entryData);
      } else {
        await addDoc(collection(db, 'users', user.uid, 'transactions'), entryData);
      }
      
      setModal({ open: true, title: 'यशस्वी!', message: 'नोंद जतन झाली.', type: 'success' });
      setEditingEntry(null);
      setActiveTab('dashboard');
      // Reset forms
      setExpenseForm({ date: new Date().toISOString().split('T')[0], voucherNo: '', particulars: '', department: settings.departments[0], amount: '', sessions: [{ hours: '', minutes: '' }], remarks: '' });
      setReceiptForm({ date: new Date().toISOString().split('T')[0], receivedFrom: '', amount: '', remarks: '' });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'transactions');
    }
  };

  const handleDelete = async (id: string) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'transactions', id));
      setModal({ open: false, title: '', message: '', type: 'success' });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, 'transactions');
    }
  };

  const handleBulkDelete = async () => {
    if (!user) return;
    try {
      const batch = writeBatch(db);
      selectedIds.forEach(id => {
        batch.delete(doc(db, 'users', user.uid, 'transactions', id));
      });
      await batch.commit();
      setSelectedIds(new Set());
      setModal({ open: false, title: '', message: '', type: 'success' });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, 'transactions');
    }
  };

  const generateInsights = async () => {
    setIsInsightLoading(true);
    try {
      const txSummary = transactions.slice(0, 50).map(t => `${t.date}|${t.type === 'receipt' ? 'जमा' : 'खर्च'}|${t.department || ''}|${t.particulars}|₹${t.amount}`).join('\n');
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `खालील रिसॉर्टच्या ताज्या ५० व्यवहारांचे विश्लेषण करा आणि ३-४ वाक्यांत अचूक आर्थिक निष्कर्ष (Financial Insights) मराठीत द्या. सर्वात मोठा खर्च कुठे झाला आणि आर्थिक स्थिती कशी आहे ते सांगा:\n\n${txSummary}`,
        config: {
          systemInstruction: "You are a financial analyst. Answer in concise Marathi. Use bullet points. Do not use asterisks.",
        }
      });
      setInsights(response.text || "अहवाल उपलब्ध नाही.");
    } catch (err) {
      console.error("Insights error:", err);
      setInsights("अहवाल बनवण्यात त्रुटी आली.");
    }
    setIsInsightLoading(false);
  };

  const handleSmartEntry = async () => {
    if (!smartInput.trim()) return;
    setIsSmartLoading(true);
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Extract transaction details from this Marathi/English text: "${smartInput}".
Current year is ${new Date().getFullYear()}, today is ${new Date().toISOString().split('T')[0]}.
Departments available: ${settings.departments.join(', ')}.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              type: { type: Type.STRING, description: "must be 'expense' or 'receipt'" },
              amount: { type: Type.NUMBER },
              particulars: { type: Type.STRING, description: "in Marathi" },
              department: { type: Type.STRING, description: "from available list" },
              date: { type: Type.STRING, description: "YYYY-MM-DD" }
            },
            required: ["type", "amount", "particulars", "date"]
          }
        }
      });
      
      const parsed = JSON.parse(response.text || "{}");
      if (parsed.type === 'receipt') {
        setActiveTab('addReceipt');
        setReceiptForm(prev => ({ ...prev, amount: parsed.amount?.toString() || '', receivedFrom: parsed.particulars || '', date: parsed.date || prev.date }));
      } else {
        setActiveTab('addExpense');
        setExpenseForm(prev => ({ ...prev, amount: parsed.amount?.toString() || '', particulars: parsed.particulars || '', department: settings.departments.includes(parsed.department) ? parsed.department : settings.departments[0], date: parsed.date || prev.date }));
      }
      setSmartInput('');
      setModal({ open: true, title: '✨ AI ने फॉर्म भरला!', message: 'कृपया माहिती तपासा आणि जतन करा.', type: 'success' });
    } catch (e) {
      console.error("Smart entry error:", e);
      setModal({ open: true, title: 'त्रुटी', message: 'ऑटो-फिल अयशस्वी झाले.', type: 'error' });
    }
    setIsSmartLoading(false);
  };

  const handleAskAi = async () => {
    if (!aiQuery.trim()) return;
    setIsAiLoading(true);
    try {
      const txSummary = transactions.map(t => `${t.date} | ${t.type === 'receipt' ? 'जमा' : 'खर्च'} | ${t.department || ''} | ${t.particulars} | ${formatCurrency(t.amount)}`).join('\n');
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `तुम्ही 'निसर्ग रिसॉर्ट' चे आर्थिक AI असिस्टंट आहात. खालील डेटा रिसॉर्टच्या सर्व जमा आणि खर्चाचा आहे:\n\n${txSummary}\n\nवापरकर्त्याचा प्रश्न: ${aiQuery}`,
        config: {
          systemInstruction: "You are a helpful financial assistant. Always respond in Marathi. Be concise and accurate. Do not use special markdown characters like asterisks.",
        }
      });
      setAiResponse(response.text || "माफ करा, मला उत्तर शोधण्यात अडचण येत आहे.");
    } catch (err) {
      console.error("AI Assistant error:", err);
      setAiResponse("AI सर्व्हरशी संपर्क होऊ शकला नाही.");
    }
    setIsAiLoading(false);
  };

  const pullFromSheet = async () => {
    if (!settings.googleSheetUrl || !settings.googleSheetUrl.includes('script.google.com')) return;
    setIsPulling(true);
    try {
      const res = await fetch(settings.googleSheetUrl);
      const d = await res.json();
      if (d.status === 'success' && d.transactions && user) {
        const batch = writeBatch(db);
        let added = 0;
        
        // Simple deduplication based on date, particulars, and amount
        const localHashes = new Set(transactions.map(t => `${t.date}|${t.particulars}|${t.amount}`));
        
        d.transactions.forEach((t: any) => {
          const hash = `${t.date}|${t.particulars}|${t.amount}`;
          if (!localHashes.has(hash)) {
            const docRef = doc(collection(db, 'users', user.uid, 'transactions'));
            batch.set(docRef, { ...t, userId: user.uid, createdAt: Date.now() - (added * 100) });
            added++;
          }
        });

        if (added > 0) {
          await batch.commit();
          setModal({ open: true, title: 'सिंक पूर्ण!', message: `${added} नवीन नोंदी जोडल्या गेल्या.`, type: 'success' });
        } else {
          setModal({ open: true, title: 'सिंक पूर्ण!', message: 'सर्व डेटा आधीच सिंक आहे.', type: 'success' });
        }
      }
    } catch (e) {
      console.error("Pull error:", e);
    } finally {
      setIsPulling(false);
    }
  };

  // --- Render Helpers ---
  const renderDashboard = () => (
    <div className="space-y-6 animate-in">
      <div className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-full text-[10px] font-black tracking-widest uppercase border ${
        dbStatus === 'connected' ? 'bg-emerald-50 text-emerald-700 border-emerald-100 shadow-sm' : 
        dbStatus === 'offline' ? 'bg-amber-50 text-amber-700 border-amber-100' : 
        'bg-red-50 text-red-700 border-red-100 animate-pulse'
      }`}>
        {dbStatus === 'connected' ? <Cloud size={14} /> : <CloudOff size={14} />}
        {dbStatus === 'connected' ? 'सिस्टम सुरक्षित जोडलेली आहे' : dbStatus === 'offline' ? 'ऑफलाईन मोड' : 'सर्व्हरशी संपर्क होत आहे...'}
      </div>

      <div className="card balance-card">
        <div className="section-title !text-slate-400">NET BALANCE</div>
        <div className="amount-large">{formatCurrency(stats.remainingAmount)}</div>
      </div>

      <div className="card">
        <div className="section-title">आर्थिक सारांश</div>
        <div className="stat-row">
          <span className="stat-label">ओपनिंग बॅलन्स ({settings.openingBalanceConfig.date})</span>
          <span className="stat-value">{formatCurrency(settings.openingBalanceConfig.amount)}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label flex items-center gap-2">एकूण जमा</span>
          <span className="stat-value text-accent">+ {formatCurrency(stats.totalReceived)}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label flex items-center gap-2">एकूण खर्च</span>
          <span className="stat-value text-danger">- {formatCurrency(stats.totalSpent)}</span>
        </div>
      </div>

      <div className="card !bg-[#eef2ff] !border-[#c7d2fe] !p-6 print-hide">
        <div className="section-title !text-[#3730a3] mb-4">
          <span>✨ AI अहवाल</span>
          <button onClick={generateInsights} disabled={isInsightLoading} className="text-[10px] font-black uppercase tracking-widest hover:underline disabled:opacity-50">
            {isInsightLoading ? 'लोड होत आहे...' : 'अहवाल काढा'}
          </button>
        </div>
        {insights ? (
          <div className="ai-box !bg-transparent !border-none !p-0">
            {insights}
          </div>
        ) : (
          <p className="text-[11px] text-[#3730a3]/70 font-bold">एका क्लिकवर तुमच्या सर्व खर्चाचे आणि जमा रकमेचे AI द्वारे विश्लेषण मिळवा.</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <button onClick={() => setActiveTab('addExpense')} className="bg-ink text-white py-4 rounded-2xl font-black text-[11px] uppercase tracking-widest active:scale-95 transition-all shadow-md">
          खर्च नोंदवा
        </button>
        <button onClick={() => setActiveTab('addReceipt')} className="bg-white border border-border text-ink py-4 rounded-2xl font-black text-[11px] uppercase tracking-widest active:scale-95 transition-all shadow-sm">
          जमा नोंदवा
        </button>
      </div>

      <div className="space-y-3">
        <button onClick={() => setActiveTab('spreadsheet')} className="w-full bg-slate-900 text-white py-5 rounded-[1.5rem] flex items-center justify-center gap-3 font-black text-xs uppercase tracking-widest shadow-xl active:scale-[0.98]">
          <Table size={20} /> मॅट्रिक्स व्ह्यू उघडा
        </button>
        <button onClick={() => window.open(VIEW_SHEET_URL, '_blank')} className="w-full bg-emerald-600 text-white py-5 rounded-[1.5rem] flex flex-col items-center justify-center gap-1 font-black text-xs uppercase tracking-widest shadow-xl active:scale-[0.98] border-b-4 border-emerald-800">
          <div className="flex items-center gap-2"><ExternalLink size={20} /> थेट स्प्रेडशीट उघडा</div>
          <span className="text-[8px] opacity-70 tracking-widest font-bold">(OPEN IN NEW TAB)</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col font-sans overflow-x-hidden">
        <ActionModal 
          isOpen={modal.open} 
          onClose={() => setModal({ ...modal, open: false })} 
          onConfirm={handleBulkDelete}
          title={modal.title} 
          message={modal.message} 
          type={modal.type} 
        />

        {/* Logo Header */}
        <header className="bg-black text-white px-10 py-5 sticky top-0 z-50 flex justify-between items-center border-b-4 border-accent print-hide">
          <div className="flex items-center gap-3">
            <div className="bg-accent p-2 rounded-lg">
              <Shield className="text-white" size={20} />
            </div>
            <h1 className="text-2xl font-black tracking-[2px] uppercase">Nisarg Resort</h1>
          </div>
          <div className="hidden sm:flex items-center gap-2 bg-[#1e293b] px-3 py-1.5 rounded-full border border-[#334155] text-[12px] font-bold">
            <div className="w-2 h-2 bg-accent rounded-full"></div>
            सिस्टम सुरक्षित जोडलेली आहे
          </div>
        </header>

        <main className="flex-1 container mx-auto px-5 py-8 max-w-2xl pb-32">
          {activeTab !== 'dashboard' && activeTab !== 'spreadsheet' && (
            <div className="card balance-card !mb-8 animate-in print-hide">
              <div className="flex justify-between items-center">
                <div className="flex flex-col">
                  <span className="section-title !text-slate-400 !mb-1">शिल्लक रक्कम</span>
                  <div className="amount-large !text-accent">{formatCurrency(stats.remainingAmount)}</div>
                </div>
                <button onClick={() => { setActiveTab('dashboard'); setEditingEntry(null); }} className="h-12 w-12 bg-white/10 rounded-2xl flex items-center justify-center active:scale-90 transition-all">
                  <ArrowLeft size={24} className="text-white" />
                </button>
              </div>
            </div>
          )}

          {activeTab === 'dashboard' && renderDashboard()}

          {(activeTab === 'addExpense' || activeTab === 'addReceipt') && (
            <div className="card space-y-8 animate-in pb-16">
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-black text-ink uppercase tracking-tight">
                  {activeTab === 'addExpense' ? (editingEntry ? 'नोंद सुधारा' : 'खर्च नोंदणी') : (editingEntry ? 'नोंद सुधारा' : 'जमा नोंदणी')}
                </h2>
                {editingEntry && (
                  <button onClick={() => { setEditingEntry(null); setExpenseForm({ date: new Date().toISOString().split('T')[0], voucherNo: '', particulars: '', department: settings.departments[0], amount: '', sessions: [{ hours: '', minutes: '' }], remarks: '' }); setReceiptForm({ date: new Date().toISOString().split('T')[0], receivedFrom: '', amount: '', remarks: '' }); }} className="btn btn-outline !p-2">
                    <X size={20} />
                  </button>
                )}
              </div>
              
              {!editingEntry && (
                <div className="card !bg-[#eef2ff] !border-[#c7d2fe] !p-5">
                  <label className="section-title !text-[#3730a3] !mb-3">
                    <span>✨ स्मार्ट नोंद (AI ऑटो-फिल)</span>
                  </label>
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      value={smartInput} 
                      onChange={e => setSmartInput(e.target.value)} 
                      placeholder="उदा. काल ट्रॅक्टरसाठी 1500 रुपये दिले..." 
                      className="flex-1 p-3 rounded-xl text-sm font-bold border border-[#c7d2fe] bg-white outline-none focus:ring-2 ring-accent" 
                    />
                    <button 
                      type="button" 
                      onClick={handleSmartEntry} 
                      disabled={isSmartLoading || !smartInput.trim()} 
                      className="btn btn-primary !py-2 !px-4 !text-[10px]"
                    >
                      {isSmartLoading ? <RefreshCw className="animate-spin" size={16}/> : 'भरून घ्या'}
                    </button>
                  </div>
                </div>
              )}

              <form onSubmit={(e) => handleSaveEntry(e, activeTab === 'addExpense' ? 'expense' : 'receipt')} className="space-y-6">
                <div className="stat-row !border-b-0 bg-bg p-4 rounded-xl border border-border">
                  <User size={20} className="text-ink-muted" />
                  <input 
                    type="text" 
                    className="flex-1 bg-transparent border-none outline-none text-sm font-bold text-ink ml-3" 
                    value={settings.enteredBy} 
                    onChange={e => setSettings({ ...settings, enteredBy: e.target.value })} 
                    placeholder="तुमचे नाव" 
                    required 
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="section-title !mb-1.5 ml-1">तारीख</label>
                    <input 
                      type="date" 
                      required 
                      className="w-full p-4 border border-border rounded-2xl text-sm font-bold bg-bg focus:ring-2 ring-ink outline-none" 
                      value={activeTab === 'addExpense' ? expenseForm.date : receiptForm.date} 
                      onChange={e => activeTab === 'addExpense' ? setExpenseForm({...expenseForm, date: e.target.value}) : setReceiptForm({...receiptForm, date: e.target.value})} 
                    />
                  </div>
                  {activeTab === 'addExpense' && (
                    <div className="space-y-1.5">
                      <label className="section-title !mb-1.5 ml-1">व्हाऊचर नं.</label>
                      <input 
                        type="text" 
                        className="w-full p-4 border border-border rounded-2xl text-sm font-bold bg-bg focus:ring-2 ring-ink outline-none" 
                        value={expenseForm.voucherNo} 
                        onChange={e => setExpenseForm({...expenseForm, voucherNo: e.target.value})} 
                        placeholder="#000" 
                      />
                    </div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <label className="section-title !mb-1.5 ml-1">{activeTab === 'addExpense' ? 'तपशील' : 'कोणाकडून मिळाले?'}</label>
                  <input 
                    type="text" 
                    required 
                    className="w-full p-4 border border-border rounded-2xl text-sm font-bold bg-bg outline-none focus:ring-2 ring-ink" 
                    value={activeTab === 'addExpense' ? expenseForm.particulars : receiptForm.receivedFrom} 
                    onChange={e => activeTab === 'addExpense' ? setExpenseForm({...expenseForm, particulars: e.target.value}) : setReceiptForm({...receiptForm, receivedFrom: e.target.value})} 
                    placeholder="..." 
                  />
                </div>
                
                {activeTab === 'addExpense' && (
                  <div className="space-y-1.5">
                    <label className="section-title !mb-1.5 ml-1">विभाग निवडा</label>
                    <select 
                      className="w-full p-4 border border-border rounded-2xl text-sm font-bold bg-bg outline-none cursor-pointer focus:ring-2 ring-ink" 
                      value={expenseForm.department} 
                      onChange={e => setExpenseForm({...expenseForm, department: e.target.value, sessions: [{ hours: '', minutes: '' }]})}
                    >
                      {settings.departments.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                )}

                {activeTab === 'addExpense' && settings.machineryTypes.includes(expenseForm.department) && (
                  <div className="space-y-3 bg-bg p-4 rounded-2xl border border-border">
                    <label className="section-title !mb-2">कामाची वेळ (SESSIONS)</label>
                    {expenseForm.sessions.map((session, index) => (
                      <div key={index} className="flex gap-4 items-end">
                        <div className="flex-1 space-y-1.5">
                          <label className="section-title !mb-1 ml-1">तास</label>
                          <input 
                            type="number" 
                            className="w-full p-3 border border-border rounded-xl text-sm font-bold bg-white outline-none focus:ring-2 ring-ink" 
                            value={session.hours} 
                            onChange={e => {
                              const newSessions = [...expenseForm.sessions];
                              newSessions[index].hours = e.target.value;
                              setExpenseForm({...expenseForm, sessions: newSessions});
                            }} 
                            placeholder="HH" 
                          />
                        </div>
                        <div className="flex-1 space-y-1.5">
                          <label className="section-title !mb-1 ml-1">मिनिटे</label>
                          <input 
                            type="number" 
                            className="w-full p-3 border border-border rounded-xl text-sm font-bold bg-white outline-none focus:ring-2 ring-ink" 
                            value={session.minutes} 
                            onChange={e => {
                              const newSessions = [...expenseForm.sessions];
                              newSessions[index].minutes = e.target.value;
                              setExpenseForm({...expenseForm, sessions: newSessions});
                            }} 
                            placeholder="MM" 
                          />
                        </div>
                        {expenseForm.sessions.length > 1 && (
                          <button 
                            type="button" 
                            onClick={() => setExpenseForm({...expenseForm, sessions: expenseForm.sessions.filter((_, i) => i !== index)})} 
                            className="btn btn-danger !p-3 !rounded-xl"
                          >
                            <Trash size={16} />
                          </button>
                        )}
                      </div>
                    ))}
                    <button 
                      type="button" 
                      onClick={() => setExpenseForm({...expenseForm, sessions: [...expenseForm.sessions, { hours: '', minutes: '' }]})} 
                      className="w-full py-3 border-2 border-dashed border-border rounded-xl text-ink-muted font-bold text-xs uppercase tracking-widest flex justify-center items-center gap-2 mt-2 hover:border-ink hover:text-ink transition-all"
                    >
                      <PlusCircle size={14} /> आणखी वेळ जोडा
                    </button>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="section-title !mb-1.5 ml-1">शेरा / टिप्पणी (REMARKS)</label>
                  <input 
                    type="text" 
                    className="w-full p-4 border border-border rounded-2xl text-sm font-bold bg-bg outline-none focus:ring-2 ring-ink" 
                    value={activeTab === 'addExpense' ? expenseForm.remarks : receiptForm.remarks} 
                    onChange={e => activeTab === 'addExpense' ? setExpenseForm({...expenseForm, remarks: e.target.value}) : setReceiptForm({...receiptForm, remarks: e.target.value})} 
                    placeholder="अतिरिक्त माहिती (ऐच्छिक)..." 
                  />
                </div>

                <div className="pt-2">
                  <label className="section-title !mb-2 !justify-center">रक्कम (INR)</label>
                  <input 
                    type="text" 
                    inputMode="numeric" 
                    required 
                    className={`w-full p-7 border-4 ${activeTab === 'addExpense' ? 'border-ink' : 'border-accent text-accent'} rounded-[2.5rem] text-5xl font-black bg-bg shadow-inner text-center outline-none focus:ring-8 focus:ring-slate-100`} 
                    value={activeTab === 'addExpense' ? expenseForm.amount : receiptForm.amount} 
                    onChange={e => {
                      const raw = e.target.value.replace(/[^0-9]/g, '');
                      activeTab === 'addExpense' ? setExpenseForm({...expenseForm, amount: raw}) : setReceiptForm({...receiptForm, amount: raw});
                    }} 
                    placeholder="0" 
                  />
                </div>
                <button type="submit" className={`w-full btn ${activeTab === 'addExpense' ? 'btn-primary' : 'bg-accent text-white shadow-lg'} !py-5 !rounded-[2rem] !text-xs mt-4`}>
                  जतन करा
                </button>
              </form>
            </div>
          )}

          {activeTab === 'history' && (
            <div className="space-y-6 animate-in pb-16">
              <div className="flex justify-between items-center px-2">
                <div>
                  <h2 className="text-xl font-black text-ink uppercase tracking-tight">व्यवहार वही</h2>
                  <p className="section-title !text-ink-muted !mb-0 mt-1">Registry History</p>
                </div>
                {selectedIds.size > 0 && (
                  <button 
                    onClick={() => setModal({ open: true, title: 'हटवायचे?', message: `${selectedIds.size} नोंदी कायमच्या हटवायच्या का?`, type: 'confirm' })} 
                    className="btn btn-danger !px-4 !py-2.5 !text-[10px] animate-bounce"
                  >
                    <Trash size={16} className="mr-2 inline" /> हटवा
                  </button>
                )}
              </div>
              <div className="space-y-4 pt-2">
                {transactions.map(t => (
                  <div key={t.id} className={`card !p-6 flex items-center gap-4 transition-all ${selectedIds.has(t.id) ? 'border-danger bg-danger/5 shadow-lg' : ''}`}>
                    <input type="checkbox" checked={selectedIds.has(t.id)} onChange={() => {
                      const newSet = new Set(selectedIds);
                      if (newSet.has(t.id)) newSet.delete(t.id); else newSet.add(t.id);
                      setSelectedIds(newSet);
                    }} className="w-6 h-6 rounded-lg accent-ink cursor-pointer" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <span className="tag">{formatDateMarathi(t.date)}</span>
                        {t.department && <span className="tag !bg-slate-100">{t.department}</span>}
                        {((t.hours || 0) > 0 || (t.minutes || 0) > 0) && (
                          <span className="tag !bg-accent/10 !text-accent !border-accent/20">{t.hours} तास {t.minutes} मि.</span>
                        )}
                      </div>
                      <div className="font-black text-ink text-base truncate">{t.particulars}</div>
                      {t.remarks && <div className="text-[10px] text-ink-muted font-bold mt-1 uppercase tracking-tight">{t.remarks}</div>}
                      <div className="text-[10px] text-ink-muted font-bold italic mt-1">By: {t.enteredBy || 'Admin'}</div>
                    </div>
                    <div className="text-right flex flex-col items-end gap-3">
                      <div className={`font-black text-lg ${t.type === 'receipt' ? 'text-accent' : 'text-danger'}`}>
                        {t.type === 'receipt' ? '+' : '-'}{formatCurrency(t.amount)}
                      </div>
                      <button 
                        onClick={() => { 
                          setEditingEntry(t); 
                          if(t.type === 'expense') { 
                            setExpenseForm({
                              date: t.date,
                              voucherNo: t.voucherNo || '',
                              particulars: t.particulars,
                              department: t.department || settings.departments[0],
                              amount: t.amount.toString(),
                              sessions: t.sessions || [{ hours: t.hours?.toString() || '', minutes: t.minutes?.toString() || '' }],
                              remarks: t.remarks || ''
                            }); 
                            setActiveTab('addExpense'); 
                          } else { 
                            setReceiptForm({
                              date: t.date, 
                              receivedFrom: t.particulars, 
                              amount: t.amount.toString(), 
                              remarks: t.remarks || ''
                            }); 
                            setActiveTab('addReceipt'); 
                          } 
                        }} 
                        className="p-2 text-ink-muted hover:text-ink bg-bg rounded-xl shadow-sm border border-border"
                      >
                        <Edit size={18} />
                      </button>
                    </div>
                  </div>
                ))}
                {transactions.length === 0 && <div className="text-center py-20 text-ink-muted font-black uppercase tracking-widest text-xs">नोंदी उपलब्ध नाहीत</div>}
              </div>
            </div>
          )}

          {activeTab === 'spreadsheet' && (
            <div className="card !p-0 overflow-hidden flex flex-col h-[75vh] animate-in">
              <div className="bg-ink p-4 sm:p-6 flex justify-between items-center shrink-0 print-hide">
                <button onClick={() => setActiveTab('dashboard')} className="btn btn-outline !text-white !border-white/20 hover:!bg-white/10 !py-2 !px-3 !text-[10px]">
                  <ArrowLeft size={16} className="mr-2 inline" /> <span className="hidden sm:inline">डॅशबोर्ड</span>
                </button>
                <div className="flex items-center gap-2 sm:gap-3">
                  <button onClick={() => window.print()} className="btn !bg-blue-600 !text-white !py-2 !px-3 sm:!px-5 !text-[10px]">
                    <Printer size={14} className="mr-2 inline" /> <span className="hidden sm:inline">PDF</span>
                  </button>
                  <button onClick={pullFromSheet} disabled={isPulling} className="btn !bg-accent !text-white !py-2 !px-3 sm:!px-5 !text-[10px] disabled:opacity-50">
                    <RefreshCw size={14} className={`mr-2 inline ${isPulling ? "animate-spin" : ""}`} /> <span className="hidden sm:inline">सिंक</span>
                  </button>
                </div>
              </div>

              <div className="overflow-auto flex-1 data-table print:overflow-visible print:h-auto">
                <table className="w-full text-[10px] border-collapse min-w-[950px] print:min-w-full">
                  <thead className="sticky top-0 bg-white z-10">
                    <tr>
                      <th>तारीख आणि वार</th>
                      <th>व्हाऊचर</th>
                      <th>नोंद (Name)</th>
                      <th>तपशील</th>
                      <th>विभाग</th>
                      <th>शेरा (Remarks)</th>
                      <th className="text-right">रक्कम (INR)</th>
                      <th className="text-center print-hide">कृती</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map(t => (
                      <tr key={t.id}>
                        <td className="whitespace-nowrap">{formatDateMarathi(t.date)}</td>
                        <td>{t.voucherNo || '—'}</td>
                        <td>{t.enteredBy || 'Admin'}</td>
                        <td className="!font-black !text-ink">{t.particulars}</td>
                        <td>
                          <span className="tag !bg-slate-100">{t.department || ""}</span>
                          {((t.hours || 0) > 0 || (t.minutes || 0) > 0) && (
                            <div className="text-[10px] text-ink-muted mt-2 font-bold bg-bg inline-block px-2 py-1 rounded-lg border border-border">
                              ⏱ {t.hours} तास {t.minutes} मि.
                            </div>
                          )}
                        </td>
                        <td>{t.remarks || '—'}</td>
                        <td className={`text-right !font-black !text-base ${t.type === 'receipt' ? '!text-accent' : '!text-ink'}`}>{formatCurrency(t.amount)}</td>
                        <td className="print-hide">
                          <div className="flex justify-center gap-2">
                            <button onClick={() => { setEditingEntry(t); setActiveTab(t.type === 'expense' ? 'addExpense' : 'addReceipt'); }} className="p-2 text-ink-muted hover:text-ink bg-white border border-border rounded-lg shadow-sm"><Edit size={16} /></button>
                            <button onClick={() => handleDelete(t.id)} className="p-2 text-ink-muted hover:text-danger bg-white border border-border rounded-lg shadow-sm"><Trash size={16} /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="space-y-8 pb-32 animate-in">
              <div className="card !p-8">
                <h2 className="text-lg font-black text-ink uppercase mb-6 border-b border-border pb-4 flex items-center gap-3 italic"><Database size={22} className="text-ink-muted" /> विभाग व्यवस्थापन</h2>
                <div className="flex flex-wrap gap-2">
                  {settings.departments.map(d => (
                    <div key={d} className="bg-bg border border-border px-4 py-3 rounded-2xl text-[10px] font-black flex items-center gap-5 uppercase tracking-tighter shadow-sm">
                      <span className="opacity-70">{d}</span>
                      <button onClick={() => setSettings({ ...settings, departments: settings.departments.filter(x => x !== d) })} className="text-ink-muted hover:text-danger transition-colors"><Trash size={16} /></button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="card !p-8">
                <h2 className="text-lg font-black text-ink uppercase mb-6 border-b border-border pb-4 flex items-center gap-3 italic"><Shield size={22} className="text-ink-muted" /> सिस्टम सेटिंग्ज</h2>
                <div className="space-y-6">
                  <div className="grid grid-cols-2 gap-5">
                    <div className="space-y-2">
                      <label className="section-title !mb-1 ml-2">ओपनिंग तारीख</label>
                      <input type="date" className="w-full p-4 border border-border rounded-2xl text-sm font-bold bg-bg outline-none focus:ring-2 ring-ink" value={settings.openingBalanceConfig.date} onChange={e => setSettings({ ...settings, openingBalanceConfig: { ...settings.openingBalanceConfig, date: e.target.value } })} />
                    </div>
                    <div className="space-y-2">
                      <label className="section-title !mb-1 ml-2">ओपनिंग रक्कम</label>
                      <input type="number" className="w-full p-4 border border-border rounded-2xl text-sm font-bold bg-bg outline-none focus:ring-2 ring-ink" value={settings.openingBalanceConfig.amount} onChange={e => setSettings({ ...settings, openingBalanceConfig: { ...settings.openingBalanceConfig, amount: Number(e.target.value) } })} />
                    </div>
                  </div>
                  <button 
                    onClick={async () => {
                      if (!user) return;
                      await setDoc(doc(db, 'users', user.uid, 'settings', 'app'), settings);
                      setModal({ open: true, title: 'जतन!', message: 'सेटिंग अपडेट झाली.', type: 'success' });
                    }} 
                    className="w-full btn btn-primary !py-5 !rounded-[2rem] !text-[11px] shadow-2xl"
                  >
                    सर्व अपडेट करा
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>

        {/* Navigation Bar */}
        <nav className="fixed bottom-0 left-0 right-0 h-20 bg-white border-t border-border flex justify-center items-center gap-12 z-[70] print-hide">
          <button onClick={() => setActiveTab('dashboard')} className={`flex flex-col items-center gap-1 transition-all ${activeTab === 'dashboard' ? 'text-ink' : 'text-ink-muted'}`}>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${activeTab === 'dashboard' ? 'bg-ink text-white' : 'bg-slate-100'}`}><Home size={20} /></div>
            <span className="text-[11px] font-extrabold uppercase">मुख्य</span>
          </button>
          <button onClick={() => setActiveTab('addExpense')} className={`flex flex-col items-center gap-1 transition-all ${activeTab === 'addExpense' || activeTab === 'addReceipt' ? 'text-ink' : 'text-ink-muted'}`}>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${activeTab === 'addExpense' || activeTab === 'addReceipt' ? 'bg-ink text-white' : 'bg-slate-100'}`}><PlusCircle size={20} /></div>
            <span className="text-[11px] font-extrabold uppercase">नोंदणी</span>
          </button>
          <button onClick={() => setActiveTab('history')} className={`flex flex-col items-center gap-1 transition-all ${activeTab === 'history' ? 'text-ink' : 'text-ink-muted'}`}>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${activeTab === 'history' ? 'bg-ink text-white' : 'bg-slate-100'}`}><List size={20} /></div>
            <span className="text-[11px] font-extrabold uppercase">वही</span>
          </button>
          <button onClick={() => setActiveTab('settings')} className={`flex flex-col items-center gap-1 transition-all ${activeTab === 'settings' ? 'text-ink' : 'text-ink-muted'}`}>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${activeTab === 'settings' ? 'bg-ink text-white' : 'bg-slate-100'}`}><SettingsIcon size={20} /></div>
            <span className="text-[11px] font-extrabold uppercase">सेटिंग</span>
          </button>
        </nav>

        {/* AI Assistant Button */}
        <div className="fixed bottom-28 right-6 z-[80] flex flex-col items-end print-hide">
          <AnimatePresence>
            {isAiOpen && (
              <motion.div 
                initial={{ opacity: 0, y: 20, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 20, scale: 0.95 }}
                className="mb-4 w-[85vw] max-w-sm bg-gradient-to-br from-indigo-900 to-slate-900 rounded-[2rem] shadow-2xl border border-indigo-500/30 p-5 relative overflow-hidden"
              >
                <div className="absolute top-0 right-0 w-40 h-40 bg-indigo-500/20 rounded-full -mr-20 -mt-20 blur-3xl"></div>
                <div className="relative z-10">
                  <div className="flex items-center justify-between mb-4 border-b border-white/10 pb-3">
                    <div className="flex items-center gap-2">
                      <div className="bg-indigo-500/30 p-1.5 rounded-lg text-indigo-300">
                        <Sparkles size={16} />
                      </div>
                      <h3 className="text-white font-black text-sm tracking-wide">निसर्ग AI <span className="text-[8px] font-bold bg-indigo-500 text-white px-2 py-0.5 rounded-full ml-1 relative -top-0.5">BETA</span></h3>
                    </div>
                  </div>
                  <textarea 
                    className="w-full bg-black/40 border border-indigo-500/30 rounded-xl p-3 text-xs text-white placeholder-indigo-300/50 outline-none focus:ring-2 focus:ring-indigo-500 resize-none font-bold"
                    rows={3}
                    placeholder="येथे विचारा (उदा. या महिन्यात ट्रॅक्टरवर किती खर्च झाला?)"
                    value={aiQuery}
                    onChange={e => setAiQuery(e.target.value)}
                  ></textarea>
                  <button 
                    onClick={handleAskAi} 
                    disabled={isAiLoading || !aiQuery.trim()}
                    className="w-full mt-3 bg-indigo-500 hover:bg-indigo-600 text-white py-3 rounded-xl font-black uppercase tracking-widest transition-all disabled:opacity-50 flex justify-center items-center gap-2 text-[10px]"
                  >
                    {isAiLoading ? <RefreshCw className="animate-spin" size={14} /> : 'माहिती काढा'}
                  </button>

                  {aiResponse && (
                    <div className="mt-4 bg-white/10 border border-white/10 rounded-xl p-4 text-indigo-50 text-[11px] font-bold leading-relaxed whitespace-pre-wrap text-left max-h-48 overflow-y-auto">
                      {aiResponse}
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          
          <button 
            onClick={() => setIsAiOpen(!isAiOpen)}
            className="bg-indigo-600 text-white p-4 rounded-full shadow-[0_10px_25px_-5px_rgba(79,70,229,0.5)] hover:bg-indigo-700 active:scale-90 transition-all border border-indigo-400/30 flex items-center justify-center"
          >
            {isAiOpen ? <X size={26} /> : <Sparkles size={26} />}
          </button>
        </div>
      </div>
  );
}
