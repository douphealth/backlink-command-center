import unittest,importlib.util,pathlib
module_path=pathlib.Path(__file__).parents[2]/'scripts'/'direct_gsc_opportunities.py'
spec=importlib.util.spec_from_file_location('direct_gsc_opportunities',module_path)
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class RankingTests(unittest.TestCase):
 def test_bad_paths(self):
  for u in ['http://gearuptofit.com/guide/','https://evil.example/guide/','https://gearuptofit.com/privacy/','https://gearuptofit.com/']:
   self.assertFalse(mod.allowed('gearuptofit.com',u))
 def test_scoring_requires_real_impressions(self):
  self.assertIsNone(mod.score('gearuptofit.com','https://gearuptofit.com/shoe-finder/',{'impressions':5,'clicks':0,'weighted_position':40,'query_samples':[]}))
 def test_eligible_ranking(self):
  rows=[{'keys':['https://gearuptofit.com/shoe-finder/','running shoe guide'],'impressions':200,'clicks':3,'position':8},{'keys':['https://gearuptofit.com/privacy/','privacy'],'impressions':999,'clicks':4,'position':7}]
  found=mod.candidate_rows('gearuptofit.com',rows,[])
  self.assertEqual(len(found),1);self.assertEqual(found[0]['promotion_status'],'RESEARCH_ONLY_NO_SEND')
if __name__=='__main__':unittest.main()
