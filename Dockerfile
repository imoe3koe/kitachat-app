# Menggunakan image resmi Node.js versi Alpine yang ringan
FROM node:18-alpine

# Tentukan direktori kerja di dalam container
WORKDIR /app

# Salin file package.json dan package-lock.json terlebih dahulu (untuk caching dependencies)
COPY package*.json ./

# Install dependencies
RUN npm install

# Salin semua file project lainnya ke dalam container
COPY . .

# Port default aplikasi (sesuaikan jika server Anda menggunakan port lain, misal 3000 atau process.env.PORT)
EXPOSE 3000

# Perintah untuk menjalankan aplikasi Anda (sesuaikan dengan "start" script di package.json Anda)
CMD ["npm", "start"]