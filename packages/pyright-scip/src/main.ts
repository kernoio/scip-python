import { main } from './main-impl';

(global as any).__rootDirectory = __dirname;

main(process.argv);
