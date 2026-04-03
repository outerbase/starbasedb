export default {
  async run(config: any) {
    const { 
      EXTERNAL_DB_TYPE, 
      EXTERNAL_DB_HOST, 
      REPLICATION_INTERVAL = 60, // dalam detik
      TABLES_TO_SYNC 
    } = config;

    console.log(`Starting replication from ${EXTERNAL_DB_HOST}...`);

    // Fungsi utama untuk narik data
    const syncData = async () => {
      for (const table of TABLES_TO_SYNC) {
        try {
          // 1. Cek ID terakhir di internal SQLite
          // 2. Tarik data dari External DB yang ID > ID_Internal
          // 3. Simpan ke SQLite internal
          console.log(`Syncing table: ${table}`);
        } catch (error) {
          console.error(`Failed to sync ${table}:`, error);
        }
      }
    };

    // Menjalankan sinkronisasi berdasarkan interval
    setInterval(syncData, REPLICATION_INTERVAL * 1000);
  }
};

