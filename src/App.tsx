import { Routes, Route } from "react-router";
import Home from "./pages/Home";
import PocTest from "./pages/PocTest";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/poc" element={<PocTest />} />
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
