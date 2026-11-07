import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { TheGrid } from './pages/TheGrid';
import { IdentityDetails } from './pages/IdentityDetails';
import { Investigations } from './pages/Investigations';
import { TheAfterlife } from './pages/TheAfterlife';
import { Remediation } from './pages/Remediation';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<TheGrid />} />
        <Route path="identities/:id" element={<IdentityDetails />} />
        <Route path="investigations" element={<Investigations />} />
        <Route path="afterlife" element={<TheAfterlife />} />
        <Route path="remediation" element={<Remediation />} />
      </Route>
    </Routes>
  );
}

export default App;
