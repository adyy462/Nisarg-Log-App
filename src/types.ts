export interface Session {
  hours: string;
  minutes: string;
}

export interface Transaction {
  id: string;
  type: 'receipt' | 'expense';
  date: string;
  amount: number;
  particulars: string;
  department?: string;
  voucherNo?: string;
  enteredBy?: string;
  remarks?: string;
  hours?: number;
  minutes?: number;
  sessions?: Session[];
  userId: string;
  createdAt: number;
  receivedFrom?: string; // For receipts
}

export interface AppSettings {
  departments: string[];
  machineryTypes: string[];
  googleSheetUrl: string;
  enteredBy: string;
  openingBalanceConfig: {
    amount: number;
    date: string;
  };
}
